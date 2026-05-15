"""FastAPI app exposing /assets, /splice, /load.

Run:
  uvicorn server.main:app --reload --port 8001

The frontend (served by python -m http.server on :8000) calls these endpoints.
"""
from __future__ import annotations

import asyncio
import atexit
import logging
import os
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .assets import ASSETS, get_asset, list_assets
from .databento_client import DatabentoClient
from .sessions import (
    add_trade_dates,
    session_close_utc,
    session_open_utc,
    trade_date_for_instant,
    trade_dates_in_range,
)
from .splice import SpliceSchedule, build_schedule, enumerate_contracts, resolve_front_month
from . import ghost as ghost_mod
from . import ranks as ranks_mod
from .live import LiveAssetManager
from .alerts import AlertManager, VALID_METRICS, VALID_OPS
from .weather.service import WeatherService

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("server")

API_KEY = os.environ.get("DATABENTO_API_KEY", "").strip()
CACHE_DIR = Path(os.environ.get("DATA_CACHE_DIR", "server/data_cache")).resolve()
CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "CORS_ORIGINS",
    "http://localhost:8000,http://127.0.0.1:8000",
).split(",") if o.strip()]

app = FastAPI(title="trade-chart server", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    # POST/DELETE needed for /alerts CRUD. Without DELETE, the preflight
    # OPTIONS request from the browser returns 400 and the actual DELETE is
    # blocked client-side — alert chips appear undeletable from the UI.
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# All 15 supported assets share the GLBX.MDP3 dataset, so a single Databento
# Live session covers them all (counts as 1 of the 10-connection-per-dataset
# Standard plan allowance). The manager is created lazily — the actual TCP
# connection isn't opened until the first ensure_subscribed call.
LIVE_MANAGER = LiveAssetManager(API_KEY, "GLBX.MDP3")

# Server-side alert engine. Wired up once API_KEY-dependent state is ready
# during _startup() — see _wire_alerts_into_live().
ALERT_MANAGER = AlertManager()

# Weather panel service. Lazily ingests Open-Meteo + NOAA AO on demand
# (spec §6 — Phase 1 ingestion is request-driven, no background scheduler).
# Cache is at server/weather/weather_cache/weather.db.
WEATHER_SERVICE = WeatherService()

# Live progress snapshot for the rank pre-warm task. Read by /live_status so
# the frontend can show "Pre-warming ranks: X/15 (current asset)" and label
# each dropdown option with its true readiness. per_asset values:
#   "pending" — queued, not yet started
#   "current" — being built right now
#   "ok"      — cache is warm
#   "failed"  — build raised; lazy-load on user click will retry
RANK_PREWARM: dict = {
    "total": 0,
    "done": 0,
    "current": None,
    "complete": False,
    "per_asset": {},
}


async def _resolve_one_for_warmup(asset_symbol: str, today: date,
                                  backfill_start: int
                                  ) -> Optional[tuple[str, str, Optional[str], int]]:
    """Identify today's front-month contract for one asset (used by pre-warm).

    Uses the lightweight resolve_front_month path — NOT the full splice
    schedule build — because the live subscription only needs to know which
    contract is active today, not the entire roll history. Cuts per-asset
    candidate fetches from ~30 (most expired/empty) to ~5 (mostly active),
    dramatically speeding up phase 1 cold start.

    Other paths (/load, /ranks, prime build) still go through build_schedule
    with full padding because they genuinely need cross-session context.
    """
    try:
        result = await asyncio.to_thread(
            resolve_front_month, _client(), asset_symbol, today,
        )
        if result is None:
            logger.warning("Pre-warm: no active contract for %s — skipping", asset_symbol)
            LIVE_MANAGER._warmup_status[asset_symbol] = "no active contract"
            return None
        raw, fallback = result
        logger.info("Pre-warm: resolved %s (active=%s, fallback=%s)", asset_symbol, raw, fallback)
        return (asset_symbol, raw, fallback, backfill_start)
    except Exception as e:
        logger.exception("Pre-warm front-month failed for %s", asset_symbol)
        LIVE_MANAGER._warmup_status[asset_symbol] = f"{type(e).__name__}: {e}"
        return None


async def _warm_live_assets() -> None:
    """Pre-warm task: resolve today's active contract for each ASSET (in
    parallel), then call LIVE_MANAGER.warm_all to do the one-shot subscribe-
    then-start sequence Databento Live requires for replay-enabled subscribes.
    """
    if not API_KEY:
        logger.warning("DATABENTO_API_KEY not set — live pre-warm skipped")
        LIVE_MANAGER._ready.set()
        return
    today = trade_date_for_instant(datetime.now(timezone.utc))
    today_midnight_utc = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )
    backfill_start = int(today_midnight_utc.timestamp())

    logger.info("Pre-warm: resolving %d assets in parallel...", len(ASSETS))
    results = await asyncio.gather(*(
        _resolve_one_for_warmup(asset, today, backfill_start)
        for asset in ASSETS.keys()
    ))
    asset_configs = [r for r in results if r is not None]

    logger.info("Pre-warm: %d/%d assets ready to subscribe", len(asset_configs), len(ASSETS))
    await LIVE_MANAGER.warm_all(asset_configs)


def _wire_alerts() -> None:
    """Connect the AlertManager to its dependencies (rank cache loader + WS
    broadcast). Called once at startup."""
    def _load_rank(asset: str, tf: int, lookback: int):
        # Alerts always evaluate against "today" — the live entry session.
        today = trade_date_for_instant(datetime.now(timezone.utc))
        # Fast-path the JSON cache before any splice work.
        cached = ranks_mod.maybe_load_cached(RANKS_CACHE_DIR, asset, tf, today, lookback)
        if cached is not None:
            return cached
        try:
            return ranks_mod.load_or_build(
                _client(), _schedule_cached_for_ranks(asset, today, lookback),
                RANKS_CACHE_DIR, asset, tf, today, lookback,
            )
        except Exception as e:
            logger.warning("alerts: rank load failed for %s tf=%dm: %s", asset, tf, e)
            return None

    ALERT_MANAGER.set_rank_loader(_load_rank)
    ALERT_MANAGER.set_broadcast(LIVE_MANAGER.broadcast_global)
    LIVE_MANAGER.set_on_finalized_bar(ALERT_MANAGER.on_finalized_bar)


def _schedule_cached_for_ranks(asset: str, entry_d: date, lookback_days: int):
    """Build/lookup the splice schedule needed for ranks computation."""
    win_start = entry_d - timedelta(days=lookback_days + 60)
    win_end = entry_d + timedelta(days=30)
    return _schedule_cached(asset, win_start.isoformat(), win_end.isoformat())


def _build_one_rank(asset: str, today: date, tf: int, lookback: int):
    """Synchronous helper. Run via asyncio.to_thread so the splice fan-out
    (which is the slow part — sequential Databento daily-volume fetches per
    contract) doesn't run on the event loop.

    Fast-path: today's rank JSON cache file may already be on disk from an
    earlier pre-warm in the same trade date. Check that BEFORE calling
    _schedule_cached_for_ranks — otherwise we pay the splice fan-out cost
    only to discover load_or_build was about to short-circuit anyway.
    """
    cached = ranks_mod.maybe_load_cached(RANKS_CACHE_DIR, asset, tf, today, lookback)
    if cached is not None:
        return cached
    sched = _schedule_cached_for_ranks(asset, today, lookback)
    return ranks_mod.load_or_build(
        _client(), sched, RANKS_CACHE_DIR, asset, tf, today, lookback,
    )


async def _prewarm_ranks_background() -> None:
    """After live warmup, pre-build rank caches for the default chart
    timeframe across every asset. Sequential to keep CPU/disk pressure low.

    On disk-cache-warm runs (same UTC day), each call is essentially free —
    load_or_build returns the cached JSON. On day-2+ cold runs, each rebuild
    re-aggregates already-cached 1s parquets, taking seconds to a minute.

    Goal: by the time a user clicks Connect on any asset, its 5m /ranks is
    instant. Other timeframes lazy-load on first user request.

    Per-asset progress is published to RANK_PREWARM so /live_status can
    surface it to the UI in near-real-time.
    """
    if not API_KEY:
        return
    # Wait for live warmup to finish so we don't compete with splice fetches.
    await LIVE_MANAGER.wait_ready(timeout=900)
    today = trade_date_for_instant(datetime.now(timezone.utc))
    tf = 5
    lookback = 365
    asset_list = list(ASSETS.keys())
    RANK_PREWARM["total"] = len(asset_list)
    RANK_PREWARM["done"] = 0
    RANK_PREWARM["current"] = None
    RANK_PREWARM["complete"] = False
    RANK_PREWARM["per_asset"] = {a: "pending" for a in asset_list}
    logger.info("rank pre-warm: starting (%d assets × tf=%dm × %dd lookback)",
                len(asset_list), tf, lookback)
    for asset in asset_list:
        RANK_PREWARM["current"] = asset
        RANK_PREWARM["per_asset"][asset] = "current"
        try:
            # Stage A: ranks (also warms the rank-window splice + per-contract
            # daily-volume parquets — that's window [today-425..today+30]).
            await asyncio.to_thread(_build_one_rank, asset, today, tf, lookback)
            # Stage B: live prime payload. The prime path uses a DIFFERENT
            # splice window than ranks ([today-122..today+180] via
            # _schedule_window_for) and a different parquet cache key
            # (databento_client.py:53 includes start/end in the filename).
            # Without warming this too, an asset can be "rank-ready" but
            # still take minutes to Connect because the prime build does its
            # own cold splice fan-out. Warming it makes the dropdown's "ok"
            # label match the user's mental model: clicking Connect is
            # actually instant.
            await _build_or_get_prime(asset)
            RANK_PREWARM["per_asset"][asset] = "ok"
            logger.info("pre-warm: %s ready (ranks tf=%dm + prime cached)", asset, tf)
        except Exception as e:
            RANK_PREWARM["per_asset"][asset] = "failed"
            logger.warning("pre-warm failed for %s: %s", asset, e)
        RANK_PREWARM["done"] += 1
    RANK_PREWARM["current"] = None
    RANK_PREWARM["complete"] = True
    logger.info("pre-warm: complete — every asset's Connect is now instant")


async def _live_watchdog() -> None:
    """30s after live warm-up completes, log a WARNING if zero records have
    arrived from Databento. Surfaces silent gateway failures (most often
    session-slot exhaustion from rapid-fire restarts under uvicorn --reload)
    so the user isn't left wondering why charts are stuck at the prime
    cutoff. Purely diagnostic — no behavior change."""
    if not API_KEY:
        return
    try:
        await LIVE_MANAGER.wait_ready(timeout=900)
    except Exception:
        return
    await asyncio.sleep(30)
    stats = LIVE_MANAGER.stats()
    if stats.get("records_received", 0) == 0:
        logger.warning(
            "Live gateway delivered 0 records 30s after session start. "
            "Most likely cause: Databento Live session-slot exhaustion "
            "(Standard plan = 10 concurrent slots; un-released slots time "
            "out gateway-side after ~5-15 min). Mitigations: wait 5-15 min "
            "then restart ONCE; prefer plain `uvicorn` over `--reload` for "
            "live testing; always single-Ctrl-C and wait for "
            "'Application shutdown complete' before restarting. Run "
            "`python scripts/probe_live.py` to confirm gateway side."
        )


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Replaces deprecated @app.on_event handlers. Modern lifespan path is
    more reliable under uvicorn --reload — the worker is given a chance to
    flush LIVE_MANAGER.stop() before being killed.

    Shutdown is bounded by asyncio.wait_for(timeout=5): a hung stop() can't
    push us past uvicorn's grace period and trigger a force-kill (which
    would prevent the graceful TCP disconnect and leak the slot).
    """
    LIVE_MANAGER.attach_loop(asyncio.get_running_loop())
    _wire_alerts()
    asyncio.create_task(_warm_live_assets())
    asyncio.create_task(_prewarm_ranks_background())
    asyncio.create_task(_live_watchdog())
    try:
        yield
    finally:
        try:
            await asyncio.wait_for(
                asyncio.to_thread(LIVE_MANAGER.stop),
                timeout=5.0,
            )
        except asyncio.TimeoutError:
            logger.warning("LIVE_MANAGER.stop() timed out after 5s — slot may leak")
        except Exception as e:
            logger.warning("LIVE_MANAGER.stop() raised: %s", e)


# Hook the lifespan into the existing FastAPI app (defined earlier in this
# module so the route decorators above kept working). app.router holds the
# lifespan_context attribute that Starlette consults.
app.router.lifespan_context = _lifespan


# atexit fires even when the lifespan context never reaches its `finally`
# (force-kill, Python exception during shutdown, etc.). Idempotent because
# LIVE_MANAGER.stop() checks `self._client is not None` — double-firing
# from both lifespan and atexit is harmless.
atexit.register(LIVE_MANAGER.stop)


def _client() -> DatabentoClient:
    if not API_KEY:
        raise HTTPException(status_code=500, detail="DATABENTO_API_KEY not configured. See .env.example.")
    return _cached_client()


@lru_cache(maxsize=1)
def _cached_client() -> DatabentoClient:
    return DatabentoClient(API_KEY, CACHE_DIR)


def _parse_date(s: str, field: str) -> date:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date for {field}: {s!r}, expected YYYY-MM-DD")


# RULE: any GET endpoint that just reads in-memory state (no Historical
# fetch, no parquet read, no splice work) MUST be `async def`, not `def`.
#
# Why: FastAPI runs `def` handlers on anyio's threadpool. Under sustained
# browser polling, each poll grabs a threadpool worker, holds the GIL
# briefly, and logs an INFO line (logger lock). The Databento Live SDK
# runs its protocol parser on a single daemon thread (`databento_live`)
# that needs the GIL to drain the TCP socket. Enough concurrent threadpool
# activity starves that thread → the kernel buffer fills → the gateway
# backpressures the send side → records stop arriving until the load
# subsides. Symptom: `records_received` stays at 0 for tens of minutes,
# then ALL buffered records flush in milliseconds the moment the load
# stops (e.g. on Ctrl+C). Reproduced and fixed 2026-05-05.
#
# Async handlers run on uvicorn's event loop, do their dict-build + JSON
# serialize between socket awaits, and never compete for the threadpool.
#
# Heavy endpoints (`/load`, `/ranks`, `/splice`, `/alerts` POST) MUST stay
# sync — they do real blocking I/O and would block the event loop if async.
@app.get("/assets")
async def assets():
    return {"assets": list_assets()}


@app.get("/health")
async def health():
    return {"ok": True, "cache_dir": str(CACHE_DIR), "api_key_configured": bool(API_KEY)}


@app.get("/live_status")
async def live_status():
    """Diagnostic snapshot of the LiveAssetManager + rank pre-warm progress.

    Hit this from a browser after starting the server to check whether records
    are flowing — if `records_received` is 0 a few seconds after
    `client_started=true`, the Live feed is silent (gateway issue or client
    misconfiguration). The frontend polls this every 3s while either warmup
    phase is incomplete to render the warm-up pill and dropdown labels."""
    return {**LIVE_MANAGER.stats(), "rank_prewarm": RANK_PREWARM}


@app.get("/alerts")
async def list_alerts():
    return {"alerts": ALERT_MANAGER.list()}


@app.post("/alerts")
def create_alert(
    asset: str = Query(...),
    metric: str = Query(..., description=f"one of {VALID_METRICS}"),
    op: str = Query(..., description=f"one of {VALID_OPS}"),
    threshold: float = Query(..., ge=0, le=100),
    tf: int = Query(...),
    lookback: int = Query(365, ge=30, le=1095),
):
    asset = asset.upper()
    if asset not in ASSETS:
        raise HTTPException(status_code=400, detail=f"unknown asset {asset!r}")
    if tf not in (1, 5, 15, 30, 60, 90, 180, 240, 1440):
        raise HTTPException(status_code=400, detail=f"unsupported tf {tf}")
    try:
        return ALERT_MANAGER.register(asset, metric, op, threshold, tf, lookback)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/alerts/{alert_id}")
def delete_alert(alert_id: str):
    ok = ALERT_MANAGER.remove(alert_id)
    if not ok:
        raise HTTPException(status_code=404, detail="alert not found")
    return {"removed": alert_id}


@app.delete("/alerts")
def clear_alerts():
    """Remove every registered alert in one call."""
    n = ALERT_MANAGER.clear()
    return {"removed": n}


@app.get("/weather")
def weather(
    date_str: str = Query(..., alias="date",
                          description="Forecast issuance date YYYY-MM-DD; in "
                                      "live mode this is today, in replay it's "
                                      "the hovered session date"),
):
    """Weather panel for one forecast vintage.

    See docs/weather-data-spec.md for the response shape and methodology.
    Phase 1: only `date == today` will trigger fresh ingestion; past dates
    return whatever's already cached (and `available: false` when nothing).
    """
    forecast_date = _parse_date(date_str, "date")
    # Sync ingestion is intentional — this is a slow path (~2s on a cold
    # cache, instant when warm), but it runs at most once per 12h per
    # vintage. Wrapping in to_thread keeps the event loop responsive.
    try:
        WEATHER_SERVICE.ensure_ingested_for(forecast_date)
    except Exception as e:
        # Don't fail the whole panel on an ingestion error — the cached
        # data may still be useful. The frontend renders what it gets.
        logger.warning("/weather ingestion failed for %s: %s",
                       forecast_date, e)
    return WEATHER_SERVICE.build_panel(forecast_date)


# Schedule cache keyed by (asset, window_start, window_end, pads). Splice
# schedules are cheap to recompute (daily volumes are parquet-cached); we
# still memoize in-process to avoid repeated file reads inside a single load
# call. pad_back/pad_forward are part of the key because narrow-pad (prime)
# and wide-pad (replay/ranks) calls produce different SpliceSchedules and
# must not share a slot.
@lru_cache(maxsize=64)
def _schedule_cached(asset: str, window_start: str, window_end: str,
                     pad_back_days: int = 180,
                     pad_forward_days: int = 400) -> SpliceSchedule:
    return build_schedule(_client(), asset,
                          datetime.strptime(window_start, "%Y-%m-%d").date(),
                          datetime.strptime(window_end, "%Y-%m-%d").date(),
                          pad_back_days=pad_back_days,
                          pad_forward_days=pad_forward_days)


def _schedule_window_for(entry: date, from_date: date, to_date: date) -> tuple[date, date]:
    """Pad window so the splice algorithm has neighbors on both sides."""
    start = min(entry, from_date) - timedelta(days=120)
    end = max(entry, to_date) + timedelta(days=180)
    return start, end


@app.get("/splice/{asset}")
def splice(
    asset: str,
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
):
    asset = asset.upper()
    if asset not in ASSETS:
        raise HTTPException(status_code=404, detail=f"Unknown asset {asset!r}")
    s = _parse_date(start, "start")
    e = _parse_date(end, "end")
    if e < s:
        raise HTTPException(status_code=400, detail="end must be >= start")
    sched = _schedule_cached(asset, s.isoformat(), e.isoformat())
    return {
        "asset": sched.asset,
        "window_start": sched.window_start.isoformat(),
        "window_end": sched.window_end.isoformat(),
        "schedule": [
            {
                "session_date": x.session_date.isoformat(),
                "active_contract": x.active_contract,
                "cumulative_spread": x.cumulative_spread,
                "incomplete_roll": x.incomplete_roll,
            }
            for x in sched.schedule
        ],
        "rolls": [
            {
                "session_date": r.session_date.isoformat(),
                "from_contract": r.from_contract,
                "to_contract": r.to_contract,
                "spread": r.spread,
                "incomplete": r.incomplete,
            }
            for r in sched.rolls
        ],
    }


def _round_price(value: float, tick_size: float, decimals: int) -> float:
    if tick_size <= 0:
        return round(value, decimals)
    return round(round(value / tick_size) * tick_size, decimals)


def _build_spliced_bars(asset: str, entry_d: date, from_d: date, to_d: date,
                        narrow_splice: bool = False) -> dict:
    """Splice + load 1s bars in entry-contract price space across [from, to].

    Pure helper — no HTTPException. Caller maps validation errors as needed.
    Used by both /load and the live websocket prime payload.

    narrow_splice: when True, use a tight splice window (±30 days around
    [from, to]) and tight enumerate pads (30 / 30). Appropriate for the
    LIVE PRIME path which only needs the schedule for the last 2 sessions
    plus minimal roll-detection context. Default (False) keeps the wide
    window required for arbitrary historical /load requests.
    """
    cfg = ASSETS[asset]
    if narrow_splice:
        # Tight window: just enough to seed the splice and detect any roll
        # that happened in the requested range. ~3-5 candidates per asset
        # vs ~30 with the default pads.
        win_start = min(entry_d, from_d) - timedelta(days=30)
        win_end = max(entry_d, to_d) + timedelta(days=30)
        sched_pad_back = 30
        sched_pad_forward = 30
    else:
        win_start, win_end = _schedule_window_for(entry_d, from_d, to_d)
        sched_pad_back = 180
        sched_pad_forward = 400
    sched = _schedule_cached(asset, win_start.isoformat(), win_end.isoformat(),
                              sched_pad_back, sched_pad_forward)
    if not sched.schedule:
        return {"asset": asset, "entry_session": entry_d.isoformat(),
                "from_session": from_d.isoformat(), "to_session": to_d.isoformat(),
                "tick_size": cfg["tick_size"], "point_value": cfg["point_value"],
                "price_decimals": cfg["price_decimals"],
                "bars": [], "rolls_in_range": [], "sessions": []}

    entry_entry = sched.lookup(entry_d)
    if entry_entry is None:
        # Pick the first scheduled session as the price-space anchor as a fallback.
        entry_entry = sched.schedule[0]
    entry_cum_spread = entry_entry.cumulative_spread
    entry_contract = entry_entry.active_contract

    requested_dates = trade_dates_in_range(from_d, to_d)
    by_date = {e.session_date: e for e in sched.schedule}

    client = _client()
    dataset = cfg["dataset"]
    tick_size = cfg["tick_size"]
    decimals = cfg["price_decimals"]

    bars_out: list[dict] = []
    sessions_out: list[dict] = []

    # Group consecutive sessions with the same active contract into a single
    # databento request so the parquet cache file covers the whole stretch.
    runs: list[tuple[str, list[date]]] = []
    for d in requested_dates:
        e = by_date.get(d)
        if e is None:
            continue
        sym = e.active_contract
        if runs and runs[-1][0] == sym:
            runs[-1][1].append(d)
        else:
            runs.append((sym, [d]))

    # Build a map raw_symbol -> Contract for fallback symbology. Use the
    # SAME pads that built the schedule so every contract in sched.schedule
    # has a fallback-map entry.
    from .splice import enumerate_contracts
    candidates = enumerate_contracts(asset, win_start, win_end,
                                      pad_back_days=sched_pad_back,
                                      pad_forward_days=sched_pad_forward)
    fallback_map = {c.raw_symbol: c.fallback_raw_symbol for c in candidates}

    for sym, dates in runs:
        run_start_utc = session_open_utc(dates[0])
        run_end_utc = session_close_utc(dates[-1])
        df = client.fetch_ohlcv_1s(
            dataset, sym, fallback_map.get(sym), run_start_utc, run_end_utc,
        )
        if df.empty:
            for d in dates:
                sessions_out.append({"session_date": d.isoformat(),
                                     "active_contract": sym,
                                     "open_t": int(session_open_utc(d).timestamp()),
                                     "bar_count": 0,
                                     "incomplete_roll": by_date[d].incomplete_roll})
            continue
        # Slice per session and translate.
        df = df.sort_index()
        df = df[(df.index >= pd.Timestamp(run_start_utc)) & (df.index <= pd.Timestamp(run_end_utc))]
        for d in dates:
            s_open = pd.Timestamp(session_open_utc(d))
            s_close = pd.Timestamp(session_close_utc(d))
            chunk = df[(df.index >= s_open) & (df.index <= s_close)]
            sched_entry = by_date[d]
            translation = sched_entry.cumulative_spread - entry_cum_spread
            count = 0
            for ts, row in chunk.iterrows():
                o = _round_price(float(row["open"]) - translation, tick_size, decimals)
                h = _round_price(float(row["high"]) - translation, tick_size, decimals)
                lo = _round_price(float(row["low"]) - translation, tick_size, decimals)
                c = _round_price(float(row["close"]) - translation, tick_size, decimals)
                v = int(row["volume"]) if not pd.isna(row["volume"]) else 0
                bars_out.append({
                    "t": int(ts.timestamp()),
                    "o": o, "h": h, "l": lo, "c": c, "v": v,
                    "s": d.isoformat(),
                    "k": sym,
                })
                count += 1
            sessions_out.append({"session_date": d.isoformat(),
                                 "active_contract": sym,
                                 "open_t": int(session_open_utc(d).timestamp()),
                                 "bar_count": count,
                                 "incomplete_roll": sched_entry.incomplete_roll})

    rolls_in_range = []
    for r in sched.rolls:
        if from_d <= r.session_date <= to_d:
            rolls_in_range.append({
                "t": int(session_open_utc(r.session_date).timestamp()),
                "session_date": r.session_date.isoformat(),
                "from_contract": r.from_contract,
                "to_contract": r.to_contract,
                "spread_raw": r.spread,
                "incomplete": r.incomplete,
            })

    logger.info(
        "/load %s entry=%s [%s..%s] -> %d bars across %d sessions, %d rolls (entry_contract=%s)",
        asset, entry_d, from_d, to_d, len(bars_out), len(sessions_out),
        len(rolls_in_range), entry_contract,
    )
    return {
        "asset": asset,
        "entry_session": entry_d.isoformat(),
        "entry_contract": entry_contract,
        "from_session": from_d.isoformat(),
        "to_session": to_d.isoformat(),
        "tick_size": tick_size,
        "point_value": cfg["point_value"],
        "price_decimals": decimals,
        "bars": bars_out,
        "rolls_in_range": rolls_in_range,
        "sessions": sessions_out,
    }


@app.get("/load")
def load(
    asset: str = Query(..., description="Asset symbol, e.g. NQ, CL, GC"),
    entry: str = Query(..., description="Entry trade-date YYYY-MM-DD (defines price space)"),
    from_date: str = Query(..., alias="from", description="First trade-date YYYY-MM-DD"),
    to_date: str = Query(..., alias="to", description="Last trade-date YYYY-MM-DD"),
):
    """Return spliced 1s bars in entry-contract price space across [from, to]."""
    asset = asset.upper()
    if asset not in ASSETS:
        raise HTTPException(status_code=404, detail=f"Unknown asset {asset!r}")
    entry_d = _parse_date(entry, "entry")
    from_d = _parse_date(from_date, "from")
    to_d = _parse_date(to_date, "to")
    if to_d < from_d:
        raise HTTPException(status_code=400, detail="to must be >= from")
    return _build_spliced_bars(asset, entry_d, from_d, to_d)


RANKS_CACHE_DIR = CACHE_DIR / "ranks"
GHOST_CACHE_DIR = CACHE_DIR / "ghost"
MIN_LOOKBACK_DAYS = 30
MAX_LOOKBACK_DAYS = 1095


@app.get("/ranks")
def ranks(
    asset: str = Query(..., description="NG, CL, NQ, or GC"),
    timeframe: int = Query(..., description="Timeframe in minutes (1, 5, 15, 30, 60, 90, 180, 240, 1440)"),
    entry: str = Query(..., description="Entry trade-date YYYY-MM-DD"),
    lookback_days: int = Query(365, description=f"{MIN_LOOKBACK_DAYS}-{MAX_LOOKBACK_DAYS}"),
):
    asset = asset.upper()
    if asset not in ASSETS:
        raise HTTPException(status_code=404, detail=f"Unknown asset {asset!r}")
    if timeframe not in (1, 5, 15, 30, 60, 90, 180, 240, 1440):
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe {timeframe}")
    if lookback_days < MIN_LOOKBACK_DAYS or lookback_days > MAX_LOOKBACK_DAYS:
        raise HTTPException(status_code=400, detail=f"lookback_days must be in [{MIN_LOOKBACK_DAYS}, {MAX_LOOKBACK_DAYS}]")
    entry_d = _parse_date(entry, "entry")

    # Fast-path: if today's rank file is already on disk, skip the splice
    # build entirely. Common case after pre-warm has run.
    cached = ranks_mod.maybe_load_cached(RANKS_CACHE_DIR, asset, timeframe,
                                          entry_d, lookback_days)
    if cached is not None:
        return cached

    # Schedule must extend back at least the lookback (with padding).
    win_start = entry_d - timedelta(days=lookback_days + 60)
    win_end = entry_d + timedelta(days=30)
    sched = _schedule_cached(asset, win_start.isoformat(), win_end.isoformat())

    return ranks_mod.load_or_build(
        _client(), sched, RANKS_CACHE_DIR,
        asset, timeframe, entry_d, lookback_days,
    )


@app.get("/ghost")
def ghost(
    asset: str = Query(..., description="NG, CL, NQ, etc."),
    timeframe: int = Query(..., description="Timeframe in minutes (1, 5, 15, 30, 60, 90, 180, 240, 1440)"),
    entry: str = Query(..., description="Entry trade-date YYYY-MM-DD"),
    lookback_days: int = Query(365, description=f"{MIN_LOOKBACK_DAYS}-{MAX_LOOKBACK_DAYS}"),
    percentile: int = Query(50, ge=1, le=99, description="Percentile picked for body, wicks, volume"),
    dow_filter: Optional[int] = Query(None, ge=0, le=4, description="0=Mon..4=Fri; omit for any"),
    wom_filter: Optional[int] = Query(None, ge=1, le=5, description="1..5 (week-of-month); omit for any"),
):
    """Per-bucket bar shape for ghost-mode overlay.

    Reuses the same splice + 1s pipeline as /ranks. Output is per ET HH:MM
    bucket: direction tallies + the chosen percentile of body, both wicks
    (stratified by direction), and volume.

    Filter+percentile params don't enter the on-disk cache key — the cache
    holds the raw per-bar tuples; filtering is applied per request. So
    flipping percentile/DoW/WoM in the UI is fast as long as the (asset,
    tf, lookback, entry) raw cache is present."""
    asset = asset.upper()
    if asset not in ASSETS:
        raise HTTPException(status_code=404, detail=f"Unknown asset {asset!r}")
    if timeframe not in (1, 5, 15, 30, 60, 90, 180, 240, 1440):
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe {timeframe}")
    if lookback_days < MIN_LOOKBACK_DAYS or lookback_days > MAX_LOOKBACK_DAYS:
        raise HTTPException(status_code=400, detail=f"lookback_days must be in [{MIN_LOOKBACK_DAYS}, {MAX_LOOKBACK_DAYS}]")
    entry_d = _parse_date(entry, "entry")

    cached = ghost_mod.maybe_load_cached(GHOST_CACHE_DIR, asset, timeframe,
                                          entry_d, lookback_days,
                                          percentile, dow_filter, wom_filter)
    if cached is not None:
        return cached

    win_start = entry_d - timedelta(days=lookback_days + 60)
    win_end = entry_d + timedelta(days=30)
    sched = _schedule_cached(asset, win_start.isoformat(), win_end.isoformat())

    return ghost_mod.load_or_build(
        _client(), sched, GHOST_CACHE_DIR,
        asset, timeframe, entry_d, lookback_days,
        percentile, dow_filter, wom_filter,
    )


@app.get("/probe")
def probe(
    raw_symbol: str = Query(..., description="e.g. NGM5, NGM25, NGN18, NGN8"),
    fallback: Optional[str] = Query(None, description="Optional fallback symbol to also try"),
    schema: str = Query("ohlcv-1d", description="ohlcv-1d, ohlcv-1s, etc."),
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD (exclusive end of day OK)"),
    dataset: str = Query("GLBX.MDP3"),
):
    """Diagnostic: hit databento directly with one (raw_symbol, schema, range)
    and report the row count. Use this to verify symbology + subscription
    coverage without running the full splice fan-out."""
    s = _parse_date(start, "start")
    e = _parse_date(end, "end")
    start_utc = datetime.combine(s, datetime.min.time(), tzinfo=timezone.utc)
    end_utc = datetime.combine(e, datetime.max.time(), tzinfo=timezone.utc)
    df = _client().fetch(dataset, raw_symbol, fallback, schema, start_utc, end_utc)
    info = {
        "raw_symbol": raw_symbol,
        "fallback": fallback,
        "schema": schema,
        "start": s.isoformat(),
        "end": e.isoformat(),
        "rows": int(len(df)),
        "first_ts": df.index[0].isoformat() if not df.empty else None,
        "last_ts": df.index[-1].isoformat() if not df.empty else None,
        "columns": list(df.columns) if not df.empty else [],
    }
    if not df.empty:
        # Sample the first row so we can see actual data
        first = df.iloc[0].to_dict()
        info["first_row"] = {k: (float(v) if hasattr(v, "item") else str(v)) for k, v in first.items()}
    return info


@app.get("/resolve_session")
async def resolve_session(instant: str = Query(..., description="ISO 8601 datetime, e.g. 2025-06-04T14:30:00-04:00")):
    """Map an arbitrary instant to a CME trade-date session.

    `async def` for the same reason as the other polling endpoints: pure
    in-memory date math, no I/O, no need to occupy a threadpool worker."""
    try:
        dt = datetime.fromisoformat(instant)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Bad instant: {instant!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    td = trade_date_for_instant(dt)
    return {"trade_date": td.isoformat(),
            "session_open_utc": session_open_utc(td).isoformat(),
            "session_close_utc": session_close_utc(td).isoformat()}


# How many trade days of historical context to send as the live prime payload.
# Kept small so live mode loads fast and switching contracts is cheap. Live's
# `start=` parameter bridges any gap between the prime's last bar and now.
LIVE_PRIME_DAYS = 2

# Replay window cap on Databento Live's `start=` parameter (just under 24h to
# leave a safety margin against the documented 24h replay limit).
LIVE_REPLAY_MAX_SECONDS = 24 * 3600 - 120


async def _build_or_get_prime(asset_in: str) -> dict:
    """Prime payload for live mode — last LIVE_PRIME_DAYS sessions of spliced
    1s bars in today's contract price space. Cached on the manager per (asset,
    today) so concurrent or repeat connections don't trigger duplicate work.

    Uses narrow_splice=True so the splice schedule is built from a tight
    contract window (~3-5 candidates instead of ~30). The active contract
    today and any in-window roll are still detected correctly; we just don't
    enumerate ~25 expired/far-future contracts that would each trigger an
    empty-marker query against Databento.
    """
    today = trade_date_for_instant(datetime.now(timezone.utc))
    cached = LIVE_MANAGER.get_cached_prime(asset_in, today)
    if cached is not None:
        return cached
    from_d = add_trade_dates(today, -LIVE_PRIME_DAYS)
    to_d = today
    prime = await asyncio.to_thread(
        _build_spliced_bars, asset_in, today, from_d, to_d, True,
    )
    LIVE_MANAGER.cache_prime(asset_in, today, prime)
    return prime


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    """Live mode: client sends {op:"subscribe",asset:"NQ"}; server replies with
    a `prime` payload (last LIVE_PRIME_DAYS sessions of spliced 1s bars in
    today's contract price space), then streams `bar` messages as new trades
    arrive on the active contract.

    Backed by the singleton LIVE_MANAGER which subscribes to all 15 assets at
    server startup on a single Databento Live connection. Switching assets is
    a cheap add_subscriber/remove_subscriber rebind — the manager flushes its
    bar_history so the new attacher backfills any gap from prime end to live.

    Outgoing: {type:"prime", payload:{...}} | {type:"bar", final:bool, bar:{...}}
              | {type:"status", message:str} | {type:"error", message:str}
    Incoming: {op:"subscribe", asset:str} | {op:"unsubscribe"}
    """
    await ws.accept()
    bar_queue: asyncio.Queue = asyncio.Queue(maxsize=100000)
    current_asset: Optional[str] = None
    # Every connected client subscribes to the global broadcast channel so
    # alerts fire regardless of which asset they're currently watching.
    LIVE_MANAGER.add_global_subscriber(bar_queue)

    async def send_loop():
        try:
            while True:
                payload = await bar_queue.get()
                await ws.send_json(payload)
        except (WebSocketDisconnect, RuntimeError):
            return

    async def recv_loop():
        nonlocal current_asset
        while True:
            try:
                msg = await ws.receive_json()
            except WebSocketDisconnect:
                return
            except Exception as e:
                logger.warning("ws recv error: %s", e)
                return
            op = (msg.get("op") or "").lower()
            if op == "subscribe":
                asset_in = (msg.get("asset") or "").upper()
                if asset_in not in ASSETS:
                    await bar_queue.put({"type": "error", "message": f"Unknown asset {asset_in!r}"})
                    continue
                if current_asset is not None and current_asset != asset_in:
                    LIVE_MANAGER.remove_subscriber(current_asset, bar_queue)
                    current_asset = None

                try:
                    prime = await _build_or_get_prime(asset_in)
                except Exception as e:
                    logger.exception("Prime build failed for %s", asset_in)
                    await bar_queue.put({"type": "error",
                                         "message": f"Prime failed: {type(e).__name__}: {e}"})
                    continue
                await bar_queue.put({"type": "prime", "payload": prime})

                if not prime.get("entry_contract"):
                    await bar_queue.put({"type": "status",
                                         "message": "No active contract resolved — historical prime only."})
                    continue
                if not API_KEY:
                    await bar_queue.put({"type": "status",
                                         "message": "DATABENTO_API_KEY not set — live feed disabled."})
                    continue

                # Wait for the startup pre-warm to finish if it's still running.
                # First-ever start with cold parquet cache can take several
                # minutes (per-contract Historical fetches); subsequent starts
                # are seconds because empty-marker cache short-circuits all
                # never-existed-contract queries.
                if not LIVE_MANAGER.is_ready():
                    await bar_queue.put({"type": "status",
                                         "message": "Live pre-warm in progress, waiting…"})
                    await LIVE_MANAGER.wait_ready(timeout=600)

                if not LIVE_MANAGER.has_asset(asset_in):
                    why = LIVE_MANAGER.warmup_status().get(asset_in, "not warmed at startup")
                    await bar_queue.put({"type": "error",
                                         "message": f"Live unavailable for {asset_in}: {why}"})
                    continue

                await LIVE_MANAGER.add_subscriber(asset_in, bar_queue)
                current_asset = asset_in
                await bar_queue.put({"type": "status",
                                     "message": f"Live: attached to {prime.get('entry_contract')} ({asset_in})."})
            elif op == "unsubscribe":
                if current_asset is not None:
                    LIVE_MANAGER.remove_subscriber(current_asset, bar_queue)
                    current_asset = None
                await bar_queue.put({"type": "status", "message": "Unsubscribed."})
            else:
                await bar_queue.put({"type": "error", "message": f"Unknown op {op!r}"})

    sender = asyncio.create_task(send_loop())
    receiver = asyncio.create_task(recv_loop())
    try:
        done, _ = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        if current_asset is not None:
            LIVE_MANAGER.remove_subscriber(current_asset, bar_queue)
        LIVE_MANAGER.remove_global_subscriber(bar_queue)
        for t in (sender, receiver):
            if not t.done():
                t.cancel()
        try:
            await ws.close()
        except Exception:
            pass
