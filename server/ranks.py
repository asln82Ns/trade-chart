"""Percentile-rank metrics: build per-bucket distributions and within-bar profiles.

For each (asset, timeframe, entry, lookback_days) we walk every weekday session
in [entry - lookback_days, entry - 1 day], read the active contract's 1s data
(via the splice schedule), aggregate to the requested timeframe, and bucket
each bar by its ET wall-clock open time (e.g. "09:00" for a 09:00-10:30 90m
bar). For each bucket we keep:

  - sorted final-volume distribution
  - sorted final-range distribution (high - low, in price units)
  - vol_profile  : 61-point averaged normalized cumulative volume curve
  - range_profile: 61-point averaged normalized cumulative range curve

The profiles are indexed by elapsed-fraction (0/60, 1/60, ..., 60/60). The
frontend uses them to estimate a forming bar's final value via empirical
profile + 10% early-window shrinkage clamp.

Notes:
- Volume and (high - low) range are translation-invariant under the splice
  spread, so using the active contract's raw bar values is identical to using
  the spliced bar values; no spread math needed in this layer.
- Bars whose final volume is 0 (degraded data) are skipped.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from .assets import get_asset
from .databento_client import DatabentoClient
from .sessions import session_close_utc, session_open_utc, trade_dates_in_range
from .splice import SpliceSchedule, enumerate_contracts

logger = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")
UTC = timezone.utc

NUM_CHECKPOINTS = 60       # 61 sample points: i in 0..60, fraction i/60
LOW_N_THRESHOLD = 20       # below this, frontend grays out the rank


def bar_open_et_unix(unix_sec: int, timeframe_min: int) -> int:
    """ET-anchored timeframe floor. Mirrors js/time-utils.js floorToTimeframe."""
    et = datetime.fromtimestamp(unix_sec, tz=UTC).astimezone(ET)
    if timeframe_min == 1440:
        if et.hour >= 18:
            anchor = et.replace(hour=18, minute=0, second=0, microsecond=0)
        else:
            anchor = (et - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
        return int(anchor.timestamp())
    midnight = et.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = int((et - midnight).total_seconds())
    bucket_sec = timeframe_min * 60
    floored = (elapsed // bucket_sec) * bucket_sec
    return int((midnight + timedelta(seconds=floored)).timestamp())


def unix_to_et_hhmm(unix_sec: int) -> str:
    """Bucket key: ET wall-clock "HH:MM" of the bar open."""
    et = datetime.fromtimestamp(unix_sec, tz=UTC).astimezone(ET)
    return f"{et.hour:02d}:{et.minute:02d}"


def _aggregate_session(df_1s: pd.DataFrame, timeframe_min: int) -> list[dict]:
    """Group 1s bars into timeframe buckets. Returns one dict per timeframe bar
    with the underlying 1s slice attached for profile computation."""
    if df_1s.empty:
        return []
    timestamps = [int(ts.timestamp()) for ts in df_1s.index]
    bar_opens = [bar_open_et_unix(t, timeframe_min) for t in timestamps]
    df = df_1s.copy()
    df["bar_open"] = bar_opens
    df["unix"] = timestamps
    out = []
    for bar_open, group in df.groupby("bar_open", sort=True):
        g = group.sort_values("unix")
        out.append({
            "open_t": int(bar_open),
            "high": float(g["high"].max()),
            "low": float(g["low"].min()),
            "volume": int(g["volume"].sum()),
            "rows": g,
        })
    return out


def _bar_profile(rows: pd.DataFrame, bar_open_t: int, timeframe_min: int,
                 num_checkpoints: int = NUM_CHECKPOINTS) -> tuple[list[float], list[float], int, float]:
    """Compute per-bar normalized cumulative profiles for volume and range.

    Returns (vol_profile, range_profile, final_volume, final_range).
    Profiles are length num_checkpoints+1; profile[0]=0 by construction,
    profile[-1]=1 by construction (when final > 0).
    """
    bar_dur = timeframe_min * 60.0
    ts = rows["unix"].tolist()
    vols = rows["volume"].tolist()
    highs = rows["high"].tolist()
    lows = rows["low"].tolist()

    vol_p = [0.0] * (num_checkpoints + 1)
    rng_p = [0.0] * (num_checkpoints + 1)

    cum_vol = 0.0
    cur_high = float("-inf")
    cur_low = float("inf")
    j = 0
    n = len(ts)
    for i in range(num_checkpoints + 1):
        target = bar_open_t + (i / num_checkpoints) * bar_dur
        while j < n and ts[j] < target:
            cum_vol += vols[j]
            if highs[j] > cur_high:
                cur_high = highs[j]
            if lows[j] < cur_low:
                cur_low = lows[j]
            j += 1
        vol_p[i] = cum_vol
        rng_p[i] = (cur_high - cur_low) if cur_high > float("-inf") else 0.0

    final_vol = vol_p[-1]
    final_rng = rng_p[-1]
    if final_vol > 0:
        vol_p = [v / final_vol for v in vol_p]
    if final_rng > 0:
        rng_p = [r / final_rng for r in rng_p]
    return vol_p, rng_p, int(final_vol), float(final_rng)


@dataclass
class _BucketAcc:
    volumes: list[int]
    ranges: list[float]
    vol_prof_sum: list[float]
    range_prof_sum: list[float]
    n: int


def build_ranks(client: DatabentoClient, schedule: SpliceSchedule, asset: str,
                timeframe_min: int, entry_date: date, lookback_days: int,
                num_checkpoints: int = NUM_CHECKPOINTS) -> dict:
    cfg = get_asset(asset)
    dataset = cfg["dataset"]

    end_date = entry_date - timedelta(days=1)
    start_date = entry_date - timedelta(days=lookback_days)
    sessions = trade_dates_in_range(start_date, end_date)
    candidates = enumerate_contracts(asset, start_date - timedelta(days=180),
                                     end_date + timedelta(days=30))
    fallback_map = {c.raw_symbol: c.fallback_raw_symbol for c in candidates}

    buckets: dict[str, _BucketAcc] = {}
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

        for bar in _aggregate_session(df, timeframe_min):
            if bar["volume"] <= 0:
                continue
            key = unix_to_et_hhmm(bar["open_t"])
            acc = buckets.get(key)
            if acc is None:
                acc = _BucketAcc(
                    volumes=[],
                    ranges=[],
                    vol_prof_sum=[0.0] * (num_checkpoints + 1),
                    range_prof_sum=[0.0] * (num_checkpoints + 1),
                    n=0,
                )
                buckets[key] = acc
            vol_p, rng_p, fv, fr = _bar_profile(bar["rows"], bar["open_t"],
                                                timeframe_min, num_checkpoints)
            acc.volumes.append(fv)
            acc.ranges.append(fr)
            for i in range(num_checkpoints + 1):
                acc.vol_prof_sum[i] += vol_p[i]
                acc.range_prof_sum[i] += rng_p[i]
            acc.n += 1

    out_buckets = {}
    for key, acc in buckets.items():
        n = acc.n
        out_buckets[key] = {
            "n": n,
            "volumes": sorted(acc.volumes),
            "ranges": sorted(acc.ranges),
            "vol_profile": [v / n for v in acc.vol_prof_sum] if n else [0.0] * (num_checkpoints + 1),
            "range_profile": [r / n for r in acc.range_prof_sum] if n else [0.0] * (num_checkpoints + 1),
        }

    logger.info(
        "/ranks %s tf=%dm entry=%s lookback=%dd: %d sessions walked, %d with data, %d buckets",
        asset, timeframe_min, entry_date, lookback_days,
        sessions_walked, sessions_with_data, len(out_buckets),
    )
    return {
        "asset": asset,
        "timeframe_min": timeframe_min,
        "entry": entry_date.isoformat(),
        "lookback_days": lookback_days,
        "num_checkpoints": num_checkpoints,
        "low_n_threshold": LOW_N_THRESHOLD,
        "n_sessions_walked": sessions_walked,
        "n_sessions_with_data": sessions_with_data,
        "buckets": out_buckets,
    }


def cache_path(cache_dir: Path, asset: str, timeframe_min: int,
               entry_date: date, lookback_days: int) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    name = f"ranks__{asset}__{timeframe_min}__{lookback_days}__{entry_date.isoformat()}.json"
    return cache_dir / name


def maybe_load_cached(cache_dir: Path, asset: str, timeframe_min: int,
                      entry_date: date, lookback_days: int) -> Optional[dict]:
    """Return the cached ranks JSON if it exists on disk, else None.

    Pure file read — does NOT trigger a splice schedule build. Use this
    as a fast-path before paying the cost of building the splice when
    today's rank file is likely already on disk from an earlier pre-warm
    in the same trade date. Without this check, callers that pass the
    schedule into load_or_build do all the splice fan-out work even when
    the JSON cache would have served the request immediately.
    """
    p = cache_path(cache_dir, asset, timeframe_min, entry_date, lookback_days)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception as exc:
        logger.warning("Failed to read ranks cache %s, will rebuild: %s", p, exc)
        return None


def load_or_build(client: DatabentoClient, schedule: SpliceSchedule,
                  cache_dir: Path, asset: str, timeframe_min: int,
                  entry_date: date, lookback_days: int) -> dict:
    p = cache_path(cache_dir, asset, timeframe_min, entry_date, lookback_days)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception as exc:
            logger.warning("Failed to read ranks cache %s, rebuilding: %s", p, exc)
    data = build_ranks(client, schedule, asset, timeframe_min, entry_date, lookback_days)
    try:
        p.write_text(json.dumps(data))
    except Exception as exc:
        logger.warning("Failed to write ranks cache %s: %s", p, exc)
    return data
