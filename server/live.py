"""Server-side LiveAssetManager: ONE Databento Live connection for all assets.

Why one connection: Databento's Standard plan allows 10 simultaneous live
sessions per dataset per team. All our assets live on GLBX.MDP3, and a single
Live session supports many `subscribe()` calls (or one with a list of symbols),
so the entire app uses 1 of those 10 slots regardless of how many assets are
streamed.

Architecture
------------
LiveAssetManager
  ├── one databento.Live() client
  ├── _assets: {asset_symbol → _AssetState}
  ├── _raw_to_asset: {raw_symbol → asset_symbol}     (for SymbolMapping)
  ├── _instrument_to_asset: {instrument_id → asset_symbol}  (built from gateway)
  └── thread-safe dispatch from databento worker thread to asyncio queues

_AssetState
  ├── raw_symbol, fallback_raw_symbol
  ├── aggregator (1s OHLCV folder)
  ├── subscribers: list[asyncio.Queue]   (WebSocket fan-out)
  └── prime_cache: (date, dict)  (per-day prime payload, shared across users)

Bar payload mirrors the historical /load bar shape so the frontend treats both
feeds identically:
    {t: unix_sec, o, h, l, c, v, s: "YYYY-MM-DD" trade_date, k: raw_symbol}
plus a `final: bool` flag at the message envelope level.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import deque
from datetime import date, datetime, timezone
from typing import Optional

from .sessions import trade_date_for_instant

# Server-side per-asset bar history depth so a re-attaching subscriber can
# catch up cleanly from the historical-prime cutoff to "now". 86400 = one day
# of finalized 1s bars per asset (many seconds have no trades and aren't
# stored, so actual depth is far less). Bounded by deque(maxlen=...) so
# memory growth is capped during long-running sessions.
HISTORY_MAXLEN = 86400

logger = logging.getLogger(__name__)

# Databento DBN trade prices are int64 with 1e-9 fixed-point scale.
PX_SCALE = 1e-9


def _record_text(record) -> str:
    """Best-effort extraction of human-readable text from a Databento Live
    record. Different record types stash the message under different
    attribute names across SDK versions: ErrorMsg → .err, SystemMsg → .msg
    or .message, sometimes .err_msg. Returns empty string for record types
    that don't carry text (TradeMsg, SymbolMappingMsg, etc.). Used to
    surface the gateway's actual reply in our logs instead of just the
    record class name."""
    for attr in ("err", "msg", "message", "err_msg"):
        v = getattr(record, attr, None)
        if v:
            try:
                return v.decode() if isinstance(v, bytes) else str(v)
            except Exception:
                return repr(v)
    return ""


class _BarAggregator:
    """Folds trades into 1s OHLCV. Single-threaded callback use only."""

    def __init__(self, raw_symbol: str):
        self.raw_symbol = raw_symbol
        self._cur: Optional[dict] = None  # {t, o, h, l, c, v, s}

    def feed(self, ts_sec: int, price: float, size: int, session_date_iso: str) -> list[dict]:
        out: list[dict] = []
        if self._cur is None or self._cur["t"] != ts_sec:
            if self._cur is not None and self._cur["t"] < ts_sec:
                out.append({
                    "type": "bar",
                    "final": True,
                    "bar": {**self._cur, "k": self.raw_symbol},
                })
            self._cur = {
                "t": ts_sec, "o": price, "h": price, "l": price, "c": price,
                "v": size, "s": session_date_iso,
            }
        else:
            self._cur["h"] = max(self._cur["h"], price)
            self._cur["l"] = min(self._cur["l"], price)
            self._cur["c"] = price
            self._cur["v"] += size
        out.append({
            "type": "bar",
            "final": False,
            "bar": {**self._cur, "k": self.raw_symbol},
        })
        return out


class _AssetState:
    def __init__(self, asset_symbol: str, raw_symbol: str, fallback_raw_symbol: Optional[str]):
        self.asset_symbol = asset_symbol
        self.raw_symbol = raw_symbol
        self.fallback_raw_symbol = fallback_raw_symbol
        self.aggregator = _BarAggregator(raw_symbol)
        self.subscribers: list[asyncio.Queue] = []
        self.prime_cache: Optional[tuple[date, dict]] = None
        # Finalized 1s-bar payloads since this asset's Live subscription started.
        # Replayed to a new subscriber on attach so they bridge the gap from
        # the (possibly older) historical prime to live with no holes.
        self.bar_history: "deque[dict]" = deque(maxlen=HISTORY_MAXLEN)
        self.lock = threading.Lock()


class LiveAssetManager:
    """Single Databento Live session, multi-asset fan-out to WebSocket queues.

    Lifecycle: warm_all() must be called exactly once at startup with the full
    list of asset configs. It opens the Live client, calls subscribe() once per
    asset (each with its own start= for replay), then calls client.start().
    Databento's API forbids new subscribes-with-start after start() — that's
    why we batch all subscribes up front.
    """

    def __init__(self, api_key: str, dataset: str):
        self.api_key = api_key
        self.dataset = dataset
        self._client = None  # databento.Live, created in warm_all()
        self._client_started = False
        self._assets: dict[str, _AssetState] = {}
        self._raw_to_asset: dict[str, str] = {}
        self._instrument_to_asset: dict[int, str] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._global_lock = threading.Lock()
        self._ready = asyncio.Event()  # set when warm_all completes (or skipped)
        self._warmup_status: dict[str, str] = {}  # asset → "ok" or error message
        # Diagnostic counters so we can tell from a snapshot whether the Live
        # feed is actually delivering records.
        self._records_received = 0
        self._trades_received = 0
        self._bars_emitted_per_asset: dict[str, int] = {}
        # Gateway ErrorMsg records (e.g. "Invalid start time", symbol-
        # resolution failures). Bounded; surfaced via stats() so a stale
        # replay start= is visible instead of inferred from silence.
        self._gateway_errors: deque[str] = deque(maxlen=64)
        # Global subscriber list: every WS client receives broadcasts (alerts)
        # regardless of which asset it's currently watching.
        self._global_subscribers: list[asyncio.Queue] = []
        # Optional callback invoked on every finalized 1s bar (asset, bar_dict).
        self._on_finalized_bar: Optional[callable] = None

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the asyncio loop used to schedule queue.put from the worker thread."""
        self._loop = loop

    def has_asset(self, asset_symbol: str) -> bool:
        return asset_symbol in self._assets

    def get_state(self, asset_symbol: str) -> Optional[_AssetState]:
        return self._assets.get(asset_symbol)

    def recent_bars(self, asset_symbol: str) -> list[dict]:
        """Snapshot of this asset's finalized 1s bar dicts (oldest→newest),
        for seeding a freshly-registered alert's forming TF bar so it
        reflects the whole in-progress bucket, not just post-registration
        trades. Returns the inner bar dicts ({t,o,h,l,c,v,s,k})."""
        st = self._assets.get(asset_symbol)
        if st is None:
            return []
        with st.lock:
            return [p["bar"] for p in st.bar_history]

    def is_ready(self) -> bool:
        return self._ready.is_set()

    def warmup_status(self) -> dict[str, str]:
        """Snapshot of per-asset warmup outcomes. Useful for status endpoints."""
        return dict(self._warmup_status)

    def stats(self) -> dict:
        """Diagnostic snapshot — call from a /live_status endpoint to see if
        the Live feed is actually delivering records, and which assets have
        emitted bars."""
        with self._global_lock:
            per_asset = {a: {
                "raw": st.raw_symbol,
                "fallback": st.fallback_raw_symbol,
                "subscribers": len(st.subscribers),
                "history_depth": len(st.bar_history),
                "bars_emitted": self._bars_emitted_per_asset.get(a, 0),
            } for a, st in self._assets.items()}
            instrument_map = dict(self._instrument_to_asset)
            gateway_errors = list(self._gateway_errors)
        return {
            "ready": self.is_ready(),
            "client_started": self._client_started,
            "records_received": self._records_received,
            "trades_received": self._trades_received,
            "instrument_count": len(instrument_map),
            "instrument_map": instrument_map,
            "gateway_errors": gateway_errors,
            "warmup_status": self.warmup_status(),
            "assets": per_asset,
        }

    async def wait_ready(self, timeout: float = 60.0) -> bool:
        """Block until warm_all has finished (or timed out). Returns True on ready."""
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def warm_all(self, asset_configs: list[tuple[str, str, Optional[str], Optional[int]]]) -> None:
        """One-shot startup: register every asset, do ONE subscribe call with
        all symbols at once, then start the session.

        Why one subscribe call: Databento's gateway throttles subscriptions at
        10/sec. Sending 15 individual subscribes in a tight loop hits that
        limit, and the subsequent client.start() races with the gateway's
        delayed-subscribe processing — we observed the session going silent
        (no acks, no records) when this happens. A single subscribe with a
        list of symbols is one subscription request; the gateway internally
        resolves each symbol to an instrument_id and dedupes.

        asset_configs: list of (asset_symbol, raw_symbol, fallback_raw_symbol, start_unix_sec).

        Subsequent calls are no-ops (warmup is one-time per process).
        """
        if self._client is not None or self._client_started:
            logger.warning("LiveAssetManager.warm_all called twice — ignoring")
            return
        if not self.api_key:
            logger.warning("DATABENTO_API_KEY not set — live feed disabled")
            self._ready.set()
            return

        # Build the combined symbol list and per-asset state map. This is
        # pure Python state — safe to do on the asyncio loop thread.
        all_symbols: list[str] = []
        common_start: Optional[int] = None
        for asset_symbol, raw_symbol, fallback_raw_symbol, start_unix_sec in asset_configs:
            state = _AssetState(
                asset_symbol, raw_symbol,
                fallback_raw_symbol if fallback_raw_symbol and fallback_raw_symbol != raw_symbol else None,
            )
            with self._global_lock:
                self._raw_to_asset[raw_symbol] = asset_symbol
                all_symbols.append(raw_symbol)
                if state.fallback_raw_symbol:
                    self._raw_to_asset[state.fallback_raw_symbol] = asset_symbol
                    all_symbols.append(state.fallback_raw_symbol)
                self._assets[asset_symbol] = state
                self._warmup_status[asset_symbol] = "ok"
            # All assets share one start time (today_midnight_UTC); take it
            # from the first config and verify the rest match.
            if common_start is None:
                common_start = start_unix_sec
            elif start_unix_sec != common_start:
                logger.warning(
                    "warm_all: per-asset start times differ (%s for %s vs common %s); using common",
                    start_unix_sec, asset_symbol, common_start,
                )

        if not self._assets:
            logger.warning("LiveAssetManager: no assets to subscribe; session not started")
            self._ready.set()
            return

        sub_kwargs = {
            "dataset": self.dataset,
            "schema": "trades",
            "stype_in": "raw_symbol",
            "symbols": all_symbols,
        }
        if common_start is not None:
            sub_kwargs["start"] = int(common_start) * 1_000_000_000

        # CRITICAL: every interaction with the databento.Live client object
        # (construction, add_callback, subscribe, start) MUST happen on a
        # single thread. Empirically, splitting subscribe and start across
        # separate asyncio.to_thread calls — which the default
        # ThreadPoolExecutor can land on different worker threads — causes
        # the gateway to silently deliver zero records. The watchdog warns
        # about this 30s after start. The single-thread fix below mirrors
        # the proven-good pattern from scripts/probe_live.py exactly.
        def _connect_subscribe_start() -> None:
            import databento as db
            self._client = db.Live(key=self.api_key)
            self._client.add_callback(self._on_record,
                                       exception_callback=self._on_exception)
            logger.info("LiveAssetManager: created databento.Live client "
                        "(will subscribe %d assets, %d symbols)",
                        len(asset_configs), len(all_symbols))
            self._client.subscribe(**sub_kwargs)
            logger.info("LiveAssetManager: subscribe sent (%d symbols, start=%s)",
                        len(all_symbols), common_start)
            # Brief wait so the gateway can process the subscription before
            # we ask it to start streaming. Kept for defense-in-depth even
            # though single-thread setup probably eliminates the race that
            # originally motivated it.
            time.sleep(0.5)
            self._client.start()
            logger.info("LiveAssetManager: session started — %d assets streaming",
                        len(self._assets))

        try:
            await asyncio.to_thread(_connect_subscribe_start)
            self._client_started = True
        except Exception as e:
            logger.exception("Live session setup failed: %s", e)
        self._ready.set()

    async def add_subscriber(self, asset_symbol: str, queue: asyncio.Queue) -> bool:
        """Register subscriber and flush bar_history with backpressure.

        The flush is async because dropping bars on QueueFull (the old
        behavior) created a visible gap on the chart between prime cutoff
        and live now: the chart would render only the partial history,
        which on reconnect looked like the bars "jumped back" to the
        prime's build time. Two changes fix that:

          1. ``await asyncio.sleep(0)`` every CHUNK items yields to the
             event loop so ``send_loop`` can drain to the WebSocket
             concurrently. Without this, the sync put-loop hogged the loop
             and the queue accumulated to its 100k cap.
          2. On QueueFull, ``await queue.put`` with a 10s timeout instead
             of ``break``. This applies real backpressure — recv_loop
             waits for the consumer to drain rather than silently
             dropping bars. The 10s timeout protects against a wedged
             consumer (browser tab paused, WebSocket dead): in that case
             we log and bail, same end state as before but only after
             genuine failure.
        """
        st = self._assets.get(asset_symbol)
        if st is None:
            return False
        with st.lock:
            if queue in st.subscribers:
                # Already attached — don't double-register or the queue will
                # receive duplicate copies of every bar.
                return True
            history_snapshot = list(st.bar_history)
            st.subscribers.append(queue)
        # Frontend dedupes by t against anything already in its tape, so
        # finalized 1s bars from server-side history bridge the gap from
        # prime cutoff to live now without doubles.
        CHUNK = 500
        for i, payload in enumerate(history_snapshot):
            if i and i % CHUNK == 0:
                await asyncio.sleep(0)
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    await asyncio.wait_for(queue.put(payload), timeout=10.0)
                except asyncio.TimeoutError:
                    logger.warning(
                        "Subscriber queue stalled flushing %s (consumer cant "
                        "drain in 10s); dropped %d remaining bars",
                        asset_symbol, len(history_snapshot) - i,
                    )
                    return True
        return True

    def remove_subscriber(self, asset_symbol: str, queue: asyncio.Queue) -> None:
        st = self._assets.get(asset_symbol)
        if st is None:
            return
        with st.lock:
            try:
                st.subscribers.remove(queue)
            except ValueError:
                pass

    def add_global_subscriber(self, queue: asyncio.Queue) -> None:
        """Register a queue to receive broadcast messages (e.g. alert fires)
        regardless of which asset is currently being watched."""
        with self._global_lock:
            if queue not in self._global_subscribers:
                self._global_subscribers.append(queue)

    def remove_global_subscriber(self, queue: asyncio.Queue) -> None:
        with self._global_lock:
            try:
                self._global_subscribers.remove(queue)
            except ValueError:
                pass

    def broadcast_global(self, payload: dict) -> None:
        """Fan a payload out to every global subscriber. Safe to call from
        the databento worker thread (uses run_coroutine_threadsafe)."""
        if self._loop is None:
            return
        with self._global_lock:
            subs = list(self._global_subscribers)
        for q in subs:
            try:
                asyncio.run_coroutine_threadsafe(q.put(payload), self._loop)
            except RuntimeError:
                return
            except Exception as e:
                logger.debug("Global broadcast put failed: %s", e)

    def set_on_finalized_bar(self, cb) -> None:
        """Register a callback called per finalized 1s bar (asset, bar_dict).
        Invoked on the databento worker thread — caller must be thread-safe
        and must not block."""
        self._on_finalized_bar = cb

    def cache_prime(self, asset_symbol: str, today: date, prime: dict) -> None:
        st = self._assets.get(asset_symbol)
        if st is None:
            return
        st.prime_cache = (today, prime)

    def get_cached_prime(self, asset_symbol: str, today: date) -> Optional[dict]:
        st = self._assets.get(asset_symbol)
        if st is None:
            return None
        if st.prime_cache and st.prime_cache[0] == today:
            return st.prime_cache[1]
        return None

    # ---- databento callbacks (run on the SDK's worker thread) ----

    def _on_record(self, record) -> None:
        self._records_received += 1
        cls_name = type(record).__name__
        # Log first 30 records in detail so a diagnostic look at the server
        # log can immediately confirm records are arriving and what they look
        # like; after that, log a summary every 1000 records. ErrorMsg /
        # SystemMsg get their text content surfaced too — without it you
        # only see "record #N: ErrorMsg" with no clue what the gateway
        # actually said.
        if self._records_received <= 30:
            extra = _record_text(record)
            if extra:
                logger.info("LiveAssetManager record #%d: %s — %s",
                            self._records_received, cls_name, extra)
            else:
                logger.info("LiveAssetManager record #%d: %s",
                            self._records_received, cls_name)
        elif self._records_received % 1000 == 0:
            logger.info("LiveAssetManager: %d records received, %d trades, instruments mapped: %d",
                        self._records_received, self._trades_received, len(self._instrument_to_asset))
        # Gateway ErrorMsg: capture and surface. These can be delivered late
        # (the SDK buffers everything until client.stop() — see Bug 3 in
        # docs/live-feed-known-issues.md), so when they DO arrive we want
        # the important ones loud. "Failed to resolve symbol ..." is benign
        # and expected (the 2-digit fallback symbols don't resolve outside
        # decade-collision years); anything else — notably "Invalid start
        # time" — is a real gateway rejection worth flagging.
        if "Error" in cls_name:
            err_text = _record_text(record)
            with self._global_lock:
                self._gateway_errors.append(err_text)
            if "Failed to resolve symbol" not in err_text:
                logger.warning("LiveAssetManager: GATEWAY ERROR — %s", err_text)
            return
        # SymbolMappingMsg comes from the gateway when it resolves a raw_symbol
        # to an instrument_id. We use that to dispatch trades to the right asset.
        if "SymbolMapping" in cls_name:
            try:
                iid = int(getattr(record, "instrument_id", 0))
                # The raw symbol is in different attrs across SDK versions.
                raw = (
                    getattr(record, "stype_in_symbol", None)
                    or getattr(record, "stype_out_symbol", None)
                    or getattr(record, "raw_symbol", None)
                )
                if raw is not None:
                    raw = raw.decode() if isinstance(raw, bytes) else str(raw)
                    raw = raw.strip().rstrip("\x00")
                if iid > 0 and raw:
                    asset = self._raw_to_asset.get(raw)
                    if asset:
                        with self._global_lock:
                            self._instrument_to_asset[iid] = asset
                        logger.info("Mapped instrument_id=%d → %s (%s)", iid, asset, raw)
            except Exception as e:
                logger.debug("SymbolMapping parse error: %s", e)
            return

        # Filter to trade-bearing records: positive size + price + ts_event.
        try:
            size = int(getattr(record, "size", 0))
            if size <= 0:
                return
            raw_price = getattr(record, "price", None)
            if raw_price is None:
                return
            ts_ns = int(getattr(record, "ts_event", 0))
            if ts_ns <= 0:
                return
            iid = int(getattr(record, "instrument_id", 0))
            if iid <= 0:
                return
        except Exception:
            return

        asset = self._instrument_to_asset.get(iid)
        if asset is None:
            return  # symbology mapping not yet received for this instrument
        st = self._assets.get(asset)
        if st is None:
            return

        ts_sec = ts_ns // 1_000_000_000
        price = float(raw_price) * PX_SCALE
        try:
            session_iso = trade_date_for_instant(
                datetime.fromtimestamp(ts_sec, tz=timezone.utc)
            ).isoformat()
        except Exception:
            session_iso = ""

        self._trades_received += 1
        try:
            payloads = st.aggregator.feed(ts_sec, price, size, session_iso)
        except Exception as e:
            logger.warning("Aggregator error for %s: %s", asset, e)
            return

        # Tag every payload with the asset symbol. The frontend filters by
        # this so bars in flight from a prior subscription don't leak onto
        # a chart that's just been switched (e.g. NG → CL would otherwise
        # paint NG bars into a CL-configured chart while the CL prime is
        # still being built). The same tag carries through bar_history so
        # re-attaching subscribers' history flushes are filterable too.
        for p in payloads:
            p["asset"] = asset

        # Append finalized payloads to the per-asset bar_history so re-attaching
        # subscribers can backfill. In-progress (final=False) payloads are not
        # buffered — they only matter live.
        finalized_bars: list[dict] = []
        with st.lock:
            for p in payloads:
                if p.get("final"):
                    st.bar_history.append(p)
                    self._bars_emitted_per_asset[asset] = self._bars_emitted_per_asset.get(asset, 0) + 1
                    finalized_bars.append(p["bar"])
            subs = list(st.subscribers)
        # Notify the optional finalized-bar callback (e.g., AlertManager) for
        # each completed 1s bar. Done on the worker thread — must be quick.
        if self._on_finalized_bar is not None and finalized_bars:
            for bar_dict in finalized_bars:
                try:
                    self._on_finalized_bar(asset, bar_dict)
                except Exception as e:
                    logger.warning("on_finalized_bar callback error: %s", e)
        if not subs or self._loop is None:
            return
        for p in payloads:
            for q in subs:
                try:
                    asyncio.run_coroutine_threadsafe(q.put(p), self._loop)
                except RuntimeError:
                    return  # loop closed
                except Exception as e:
                    logger.debug("Queue put failed: %s", e)

    def _on_exception(self, exc: BaseException) -> None:
        msg = f"Live feed error: {type(exc).__name__}: {exc}"
        logger.warning(msg)
        if self._loop is None:
            return
        with self._global_lock:
            states = list(self._assets.values())
        payload = {"type": "error", "message": msg}
        for st in states:
            with st.lock:
                subs = list(st.subscribers)
            for q in subs:
                try:
                    asyncio.run_coroutine_threadsafe(q.put(payload), self._loop)
                except Exception:
                    pass

    def stop(self) -> None:
        if self._client is not None:
            try:
                self._client.stop()
            except Exception as e:
                logger.debug("Live stop error (benign): %s", e)
