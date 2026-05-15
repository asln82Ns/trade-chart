"""Ghost bars: per-bucket median bar shape across the same lookback window
that drives /ranks.

Two-stage pipeline:

  build_ghost_raw → walks the lookback once, collects per-bar tuples
  (date_iso, dow, wom, dir, body, lwick, uwick, vol) per ET HH:MM bucket.
  This is the slow step — same cost as a /ranks build. Cached on disk.

  apply_filters_and_percentile → fast: filter bars by day-of-week and/or
  week-of-month, then pick the requested percentile of body, both wicks
  (stratified by direction), and volume per bucket. Runs per request,
  no disk I/O.

This split lets users change percentile / DoW / WoM filters without
re-walking the lookback every time. Cache file is per (asset, tf,
lookback, entry); filter+percentile params don't enter the cache key.

Wick definitions match candlestick convention:
  blue  (close > open):  lower wick = open  - low,   upper wick = high - close
  gray  (close < open):  lower wick = close - low,   upper wick = high - open
  doji  (close == open): excluded from direction tally and from shape medians;
                          contributes to bucket N and to volume distribution.

dir codes in the raw tuple: 0 = gray, 1 = blue, 2 = doji.
dow:  Mon=0 .. Fri=4 (weekend never present, sessions are weekday-anchored).
wom:  1..5 (week-of-month by day-of-month / 7).

Cache file format is versioned ("version": 2) so older P50-only files are
ignored and rebuilt cleanly.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd

from .assets import get_asset
from .databento_client import DatabentoClient
from .ranks import _aggregate_session, unix_to_et_hhmm
from .sessions import session_close_utc, session_open_utc, trade_dates_in_range
from .splice import SpliceSchedule, enumerate_contracts

logger = logging.getLogger(__name__)

CACHE_VERSION = 2

DIR_GRAY = 0
DIR_BLUE = 1
DIR_DOJI = 2


@dataclass
class _RawBucket:
    bars: list = field(default_factory=list)


def _bar_open_close(rows: pd.DataFrame) -> tuple[float, float]:
    """First-1s open and last-1s close of an aggregated TF bar."""
    sorted_rows = rows.sort_values("unix")
    return float(sorted_rows["open"].iloc[0]), float(sorted_rows["close"].iloc[-1])


def _week_of_month(d: date) -> int:
    """1-5; week 1 = days 1-7, week 2 = 8-14, etc."""
    return (d.day - 1) // 7 + 1


def _percentile(sorted_list: list[float], p: float) -> float:
    """Nearest-rank percentile from an already-sorted list. p in [0, 1].
    Returns 0.0 for an empty list."""
    if not sorted_list:
        return 0.0
    if p <= 0:
        return float(sorted_list[0])
    if p >= 1:
        return float(sorted_list[-1])
    idx = int(p * (len(sorted_list) - 1))
    return float(sorted_list[idx])


def build_ghost_raw(client: DatabentoClient, schedule: SpliceSchedule, asset: str,
                    timeframe_min: int, entry_date: date,
                    lookback_days: int) -> dict:
    """Build the raw per-bar tuple cache. Returns the dict that gets written
    to disk. apply_filters_and_percentile turns this into the response shape."""
    cfg = get_asset(asset)
    dataset = cfg["dataset"]

    end_date = entry_date - timedelta(days=1)
    start_date = entry_date - timedelta(days=lookback_days)
    sessions = trade_dates_in_range(start_date, end_date)
    candidates = enumerate_contracts(asset, start_date - timedelta(days=180),
                                     end_date + timedelta(days=30))
    fallback_map = {c.raw_symbol: c.fallback_raw_symbol for c in candidates}

    buckets: dict[str, _RawBucket] = {}
    sessions_walked = 0
    sessions_with_data = 0

    for session in sessions:
        sched_entry = schedule.lookup(session)
        if sched_entry is None:
            continue
        sessions_walked += 1
        sym = sched_entry.active_contract
        s_open = session_open_utc(session)
        s_close = session_close_utc(session)
        df = client.fetch_ohlcv_1s(dataset, sym, fallback_map.get(sym), s_open, s_close)
        if df.empty:
            continue
        df = df[(df.index >= pd.Timestamp(s_open)) & (df.index <= pd.Timestamp(s_close))]
        if df.empty:
            continue
        sessions_with_data += 1
        dow = session.weekday()  # 0=Mon..6=Sun (sessions are weekday-only)
        wom = _week_of_month(session)

        for bar in _aggregate_session(df, timeframe_min):
            if bar["volume"] <= 0:
                continue
            o, c = _bar_open_close(bar["rows"])
            h = bar["high"]
            lo = bar["low"]
            vol = float(bar["volume"])
            if c > o:
                dir_int = DIR_BLUE
                body = c - o
                lwick = o - lo
                uwick = h - c
            elif c < o:
                dir_int = DIR_GRAY
                body = o - c
                lwick = c - lo
                uwick = h - o
            else:
                dir_int = DIR_DOJI
                body = 0.0
                lwick = 0.0
                uwick = 0.0
            key = unix_to_et_hhmm(bar["open_t"])
            acc = buckets.get(key)
            if acc is None:
                acc = _RawBucket()
                buckets[key] = acc
            # Tuple-as-list for JSON serializability.
            acc.bars.append([
                session.isoformat(), dow, wom, dir_int,
                body, lwick, uwick, vol,
            ])

    logger.info(
        "/ghost(raw) %s tf=%dm entry=%s lookback=%dd: %d sessions walked, "
        "%d with data, %d buckets",
        asset, timeframe_min, entry_date, lookback_days,
        sessions_walked, sessions_with_data, len(buckets),
    )
    return {
        "version": CACHE_VERSION,
        "asset": asset,
        "timeframe_min": timeframe_min,
        "entry": entry_date.isoformat(),
        "lookback_days": lookback_days,
        "n_sessions_walked": sessions_walked,
        "n_sessions_with_data": sessions_with_data,
        "raw_buckets": {key: {"bars": acc.bars} for key, acc in buckets.items()},
    }


def apply_filters_and_percentile(raw: dict, percentile: int = 50,
                                  dow_filter: Optional[int] = None,
                                  wom_filter: Optional[int] = None) -> dict:
    """Filter + percentile-pick the raw cache into the response shape the
    frontend consumes. Pure function; no I/O."""
    p = max(0.0, min(1.0, percentile / 100.0))
    out_buckets: dict[str, dict] = {}
    for key, bucket in raw.get("raw_buckets", {}).items():
        bars = bucket.get("bars", [])
        if dow_filter is not None:
            bars = [b for b in bars if b[1] == dow_filter]
        if wom_filter is not None:
            bars = [b for b in bars if b[2] == wom_filter]
        n_blue = 0
        n_gray = 0
        n_doji = 0
        bodies_blue: list[float] = []
        bodies_gray: list[float] = []
        lwicks_blue: list[float] = []
        lwicks_gray: list[float] = []
        uwicks_blue: list[float] = []
        uwicks_gray: list[float] = []
        vols: list[float] = []
        for b in bars:
            d = b[3]
            vols.append(b[7])
            if d == DIR_BLUE:
                n_blue += 1
                bodies_blue.append(b[4])
                lwicks_blue.append(b[5])
                uwicks_blue.append(b[6])
            elif d == DIR_GRAY:
                n_gray += 1
                bodies_gray.append(b[4])
                lwicks_gray.append(b[5])
                uwicks_gray.append(b[6])
            else:
                n_doji += 1
        bodies_blue.sort()
        bodies_gray.sort()
        lwicks_blue.sort()
        lwicks_gray.sort()
        uwicks_blue.sort()
        uwicks_gray.sort()
        vols.sort()
        out_buckets[key] = {
            "n_blue": n_blue,
            "n_gray": n_gray,
            "n_doji": n_doji,
            "body_blue": _percentile(bodies_blue, p),
            "body_gray": _percentile(bodies_gray, p),
            "lwick_blue": _percentile(lwicks_blue, p),
            "lwick_gray": _percentile(lwicks_gray, p),
            "uwick_blue": _percentile(uwicks_blue, p),
            "uwick_gray": _percentile(uwicks_gray, p),
            "volume": _percentile(vols, p),
        }
    return {
        "asset": raw.get("asset"),
        "timeframe_min": raw.get("timeframe_min"),
        "entry": raw.get("entry"),
        "lookback_days": raw.get("lookback_days"),
        "n_sessions_walked": raw.get("n_sessions_walked", 0),
        "n_sessions_with_data": raw.get("n_sessions_with_data", 0),
        "percentile": percentile,
        "dow_filter": dow_filter,
        "wom_filter": wom_filter,
        "buckets": out_buckets,
    }


def cache_path(cache_dir: Path, asset: str, timeframe_min: int,
               entry_date: date, lookback_days: int) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    name = f"ghost__{asset}__{timeframe_min}__{lookback_days}__{entry_date.isoformat()}.v2.json"
    return cache_dir / name


def _load_raw_or_build(client: DatabentoClient, schedule: SpliceSchedule,
                      cache_dir: Path, asset: str, timeframe_min: int,
                      entry_date: date, lookback_days: int) -> dict:
    p = cache_path(cache_dir, asset, timeframe_min, entry_date, lookback_days)
    if p.exists():
        try:
            data = json.loads(p.read_text())
            if data.get("version") == CACHE_VERSION:
                return data
            logger.info("ghost cache version mismatch, rebuilding %s", p)
        except Exception as exc:
            logger.warning("Failed to read ghost cache %s, rebuilding: %s", p, exc)
    raw = build_ghost_raw(client, schedule, asset, timeframe_min, entry_date, lookback_days)
    try:
        p.write_text(json.dumps(raw))
    except Exception as exc:
        logger.warning("Failed to write ghost cache %s: %s", p, exc)
    return raw


def load_or_build(client: DatabentoClient, schedule: SpliceSchedule,
                  cache_dir: Path, asset: str, timeframe_min: int,
                  entry_date: date, lookback_days: int,
                  percentile: int = 50,
                  dow_filter: Optional[int] = None,
                  wom_filter: Optional[int] = None) -> dict:
    raw = _load_raw_or_build(client, schedule, cache_dir, asset, timeframe_min,
                              entry_date, lookback_days)
    return apply_filters_and_percentile(raw, percentile, dow_filter, wom_filter)


def maybe_load_cached(cache_dir: Path, asset: str, timeframe_min: int,
                      entry_date: date, lookback_days: int,
                      percentile: int = 50,
                      dow_filter: Optional[int] = None,
                      wom_filter: Optional[int] = None) -> Optional[dict]:
    """Read the raw cache if present and apply filter+percentile. Returns
    None if the cache file is missing — the caller should fall through to
    load_or_build (which will trigger a build)."""
    p = cache_path(cache_dir, asset, timeframe_min, entry_date, lookback_days)
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text())
        if raw.get("version") != CACHE_VERSION:
            return None
        return apply_filters_and_percentile(raw, percentile, dow_filter, wom_filter)
    except Exception as exc:
        logger.warning("Failed to read ghost cache %s, will rebuild: %s", p, exc)
        return None
