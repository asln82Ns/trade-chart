"""Thin wrapper around databento.Historical with parquet caching.

Two cache strategies, picked per schema:

1. ROLLING per-contract cache (ohlcv-1d only). One parquet per
   (dataset, raw_symbol, schema), stored under cache_dir/rolling/. On read,
   slice to requested [start, end]. On miss-tail, fetch only the gap
   [cached_max+1day, end] and atomically merge. This survives the daily UTC
   midnight rollover that otherwise invalidates exact (start, end)-keyed
   filenames and forces a full daily refetch of every futures contract.

2. EXACT-keyed cache (ohlcv-1s, anything else). Filename includes both
   start and end dates. Appropriate for session-bounded data whose ranges
   don't overlap usefully across requests.

Empty results in the rolling path are NOT cached as .empty markers, because
a contract that hasn't started trading today might start tomorrow — a sticky
empty would silently mask it. Empty re-queries are cheap (~0.3s each, run in
parallel during pre-warm) and only happen on cold-process start (the splice
schedule is lru_cached in main.py). Exact-keyed schemas keep their .empty
markers since the (start, end) range is itself a strong identifier.

Symbology fallback: CME futures raw_symbol used 1-digit year (NGM5) for older
contracts and 2-digit year (NGM25) for newer. We try the 2-digit form first,
fall back to 1-digit if no rows came back.
"""
from __future__ import annotations

import logging
import threading
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Silence Databento's chatty informational warnings: "No data found",
# "symbols which did not resolve", "days with reduced quality (degraded)",
# etc. We surface them at debug level instead, since for our splice-fan-out
# many symbols legitimately have no data in a given window (expired contracts).
try:
    from databento.common.error import BentoWarning  # type: ignore
    warnings.simplefilter("ignore", BentoWarning)
except Exception:
    # Older/newer databento layouts: fall back to filtering by class name.
    warnings.filterwarnings("ignore", message=".*", category=Warning, module=r"databento.*")


def _safe(s: str) -> str:
    return s.replace(".", "_").replace(":", "").replace("/", "_")


# Subdirectory holding rolling per-contract parquets. Sits inside cache_dir/
# alongside the legacy date-keyed flat files. Old date-keyed files are not
# moved or deleted — they're orphaned but harmless. _import_legacy_for_rolling
# reads them once on first rolling miss so day-1 of this code reuses prior
# pre-warm fetches and we don't pay another full cold-cache cycle.
ROLLING_DIR_NAME = "rolling"

# Schemas eligible for the rolling cache. Daily volumes are inherently
# append-only over time — perfect for rolling. 1s data is session-bounded and
# the existing exact-keyed cache is already correct for it.
ROLLING_SCHEMAS = frozenset({"ohlcv-1d"})


class DatabentoClient:
    def __init__(self, api_key: str, cache_dir: Path):
        # Lazy import so the module loads even if databento isn't installed yet
        # (handy during dev / unit tests).
        import databento as db
        self._db = db
        self._client = db.Historical(api_key)
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # Per-(dataset, raw_symbol, schema) lock so concurrent rolling-cache
        # readers/writers can't double-fetch the missing tail or partially
        # overwrite each other. Created on demand.
        self._rolling_locks: dict[tuple, threading.Lock] = {}
        self._rolling_locks_master = threading.Lock()

    def _cache_path(self, dataset: str, raw_symbol: str, schema: str,
                    start: datetime, end: datetime) -> Path:
        s = start.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        e = end.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        name = f"{_safe(dataset)}__{_safe(raw_symbol)}__{_safe(schema)}__{s}__{e}.parquet"
        return self.cache_dir / name

    def _rolling_path(self, dataset: str, raw_symbol: str, schema: str) -> Path:
        return (self.cache_dir / ROLLING_DIR_NAME /
                _safe(dataset) / _safe(raw_symbol) / f"{_safe(schema)}.parquet")

    def _get_rolling_lock(self, dataset: str, raw_symbol: str,
                          schema: str) -> threading.Lock:
        key = (dataset, raw_symbol, schema)
        with self._rolling_locks_master:
            lock = self._rolling_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._rolling_locks[key] = lock
            return lock

    def _atomic_write_parquet(self, df: pd.DataFrame, path: Path) -> None:
        """Write parquet to a sibling .tmp then rename. A crash mid-write
        leaves the previous good version in place rather than a half-written
        corrupt file. Path.replace() (os.replace) is atomic on POSIX and on
        Windows when source and destination share a directory."""
        path.parent.mkdir(parents=True, exist_ok=True)
        # Use with_name (not with_suffix) — with_suffix validates the suffix
        # form and can reject ".parquet.tmp" depending on pathlib version.
        tmp = path.with_name(path.name + ".tmp")
        df.to_parquet(tmp)
        tmp.replace(path)

    def _import_legacy_for_rolling(self, dataset: str, raw_symbol: str,
                                    schema: str) -> Optional[pd.DataFrame]:
        """One-time salvage. If the rolling parquet doesn't exist yet but
        legacy date-keyed parquets for the same contract+schema do, merge
        them so the rolling cache starts populated. Without this, the first
        run after upgrade would re-fetch every contract from databento."""
        pattern = f"{_safe(dataset)}__{_safe(raw_symbol)}__{_safe(schema)}__*.parquet"
        legacy = list(self.cache_dir.glob(pattern))
        if not legacy:
            return None
        dfs: list[pd.DataFrame] = []
        for p in legacy:
            try:
                df = self._ensure_utc(pd.read_parquet(p))
                if not df.empty:
                    dfs.append(df)
            except Exception as e:
                logger.debug("legacy import skip %s: %s", p, e)
        if not dfs:
            return None
        merged = pd.concat(dfs).sort_index()
        merged = merged[~merged.index.duplicated(keep="last")]
        return merged

    def _fetch_one(self, dataset: str, raw_symbol: str, schema: str,
                   start: datetime, end: datetime) -> pd.DataFrame:
        """Try a single raw_symbol, return df (possibly empty), no caching here."""
        try:
            data = self._client.timeseries.get_range(
                dataset=dataset,
                schema=schema,
                symbols=[raw_symbol],
                stype_in="raw_symbol",
                start=start,
                end=end,
            )
            df = data.to_df()
        except Exception as exc:  # databento raises various; treat as empty
            msg = str(exc)
            if "data_end_after_available_end" in msg or "data_start_before_available_start" in msg:
                logger.debug("databento range issue for %s %s [%s..%s]: %s",
                             raw_symbol, schema, start, end, msg)
            else:
                logger.warning("databento error for %s %s [%s..%s]: %s",
                               raw_symbol, schema, start, end, exc)
            return pd.DataFrame()
        if df is None or df.empty:
            return pd.DataFrame()
        # Standardize index to a tz-aware UTC DatetimeIndex named ts_event.
        if not isinstance(df.index, pd.DatetimeIndex):
            df = df.reset_index()
        if df.index.tz is None:
            df.index = df.index.tz_localize("UTC")
        else:
            df.index = df.index.tz_convert("UTC")
        return df

    @staticmethod
    def _ensure_utc(df: pd.DataFrame) -> pd.DataFrame:
        if df is None or df.empty:
            return df if df is not None else pd.DataFrame()
        if isinstance(df.index, pd.DatetimeIndex):
            if df.index.tz is None:
                df.index = df.index.tz_localize("UTC")
            else:
                df.index = df.index.tz_convert("UTC")
        return df

    @staticmethod
    def _clamp_end(end: datetime) -> datetime:
        """Clamp end to start-of-today UTC so we never request future data
        (Databento returns 422 ``data_end_after_available_end`` otherwise)."""
        today_midnight = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return min(end, today_midnight)

    def fetch(self, dataset: str, raw_symbol: str, fallback_raw_symbol: Optional[str],
              schema: str, start: datetime, end: datetime) -> pd.DataFrame:
        """Cached fetch with symbology fallback. Routes ohlcv-1d through the
        rolling per-contract cache (survives daily UTC midnight rollover);
        all other schemas use the original exact (start, end) keying with
        .empty markers for never-existed contracts."""
        if schema in ROLLING_SCHEMAS:
            return self._fetch_rolling(dataset, raw_symbol, fallback_raw_symbol,
                                        schema, start, end)
        return self._fetch_exact(dataset, raw_symbol, fallback_raw_symbol,
                                  schema, start, end)

    def _fetch_exact(self, dataset: str, raw_symbol: str,
                      fallback_raw_symbol: Optional[str],
                      schema: str, start: datetime, end: datetime) -> pd.DataFrame:
        """Exact (start, end)-keyed cache with .empty markers. Used for
        schemas where each request's range is a strong identifier and ranges
        don't share usefully across requests (e.g. ohlcv-1s session windows).
        """
        end = self._clamp_end(end)
        if not (start < end):
            return pd.DataFrame()
        path = self._cache_path(dataset, raw_symbol, schema, start, end)
        empty_marker = Path(str(path) + ".empty")

        if path.exists():
            try:
                return self._ensure_utc(pd.read_parquet(path))
            except Exception as exc:
                logger.warning("Failed to read cache %s, refetching: %s", path, exc)
        if empty_marker.exists():
            return pd.DataFrame()

        df = self._fetch_one(dataset, raw_symbol, schema, start, end)
        logger.info("fetch %s %s [%s..%s]: %d rows",
                    raw_symbol, schema, start.date(), end.date(), len(df))
        if df.empty and fallback_raw_symbol and fallback_raw_symbol != raw_symbol:
            df_fb = self._fetch_one(dataset, fallback_raw_symbol, schema, start, end)
            logger.info("fetch fallback %s %s [%s..%s]: %d rows",
                        fallback_raw_symbol, schema, start.date(), end.date(), len(df_fb))
            df = df_fb

        if not df.empty:
            try:
                df.to_parquet(path)
            except Exception as exc:
                logger.warning("Failed to write cache %s: %s", path, exc)
        else:
            try:
                empty_marker.touch()
            except Exception as exc:
                logger.warning("Failed to write empty marker %s: %s", empty_marker, exc)
        return df

    def _fetch_rolling(self, dataset: str, raw_symbol: str,
                        fallback_raw_symbol: Optional[str],
                        schema: str, start: datetime, end: datetime) -> pd.DataFrame:
        """Rolling per-contract cache. One parquet per (dataset, raw_symbol,
        schema) under cache_dir/rolling/. Read existing → slice; if cache is
        short on the tail, fetch only the gap and merge atomically. No
        .empty marker — empties are re-queried on cold-process start so a
        contract that newly starts trading isn't permanently masked.

        Tail-grace: we consider the cache "current" if its max bar is within
        1 day of the clamped end, since today's daily bar typically isn't
        published until after the session closes. Without grace, every cold
        start would refetch the latest day for every contract.

        Window-prefix backfill: CME 1-digit-year raw_symbols cycle every
        decade (NGG5 means Feb 1995 / 2005 / 2015 / 2025 / 2035 — the
        gateway disambiguates by date range, but our cache is keyed by
        symbol alone). A live-mode pre-warm of NGG25 (Feb 2025) writes
        2025 rows into NGG5/ohlcv-1d.parquet; a later replay query for
        2015 then sees an empty slice because the cache contains only
        2025 data. The forward-fill path won't trigger because
        cached_max (2025) is past the requested end (2015), so without
        a backward path the schedule never gets daily volumes for the
        right era and downstream /load returns 0 bars (or sticks on an
        expired front month). After the forward-fill, if the slice is
        empty OR starts later than start+grace, we fetch the missing
        prefix. Self-healing: one fetch per first-encountered window;
        both decades coexist in the file afterward; subsequent queries
        of either era hit cache. Reproduced and fixed 2026-05-05.
        """
        end = self._clamp_end(end)
        if not (start < end):
            return pd.DataFrame()

        path = self._rolling_path(dataset, raw_symbol, schema)
        lock = self._get_rolling_lock(dataset, raw_symbol, schema)

        with lock:
            cached = pd.DataFrame()
            if path.exists():
                try:
                    cached = self._ensure_utc(pd.read_parquet(path))
                    if not cached.empty:
                        cached = cached.sort_index()
                except Exception as e:
                    logger.warning("rolling cache unreadable %s: %s — refetching",
                                   path, e)
                    cached = pd.DataFrame()
            else:
                # First time accessing this contract under the rolling layout.
                # Pull in any legacy date-keyed parquets so we don't pay a
                # fresh cold fetch when prior pre-warms already pulled this.
                imported = self._import_legacy_for_rolling(dataset, raw_symbol, schema)
                if imported is not None and not imported.empty:
                    try:
                        self._atomic_write_parquet(imported, path)
                        logger.info("rolling cache initialized from legacy: %s %s (%d rows)",
                                    raw_symbol, schema, len(imported))
                    except Exception as e:
                        logger.warning("legacy-init write failed for %s: %s", path, e)
                    cached = imported

            cached_max: Optional[pd.Timestamp] = None
            if not cached.empty and isinstance(cached.index, pd.DatetimeIndex):
                cached_max = cached.index.max()

            end_ts = pd.Timestamp(end)
            start_ts = pd.Timestamp(start)
            grace = pd.Timedelta(days=1)
            need_fetch = (cached_max is None or cached_max < end_ts - grace)

            # Expired-window skip. If this contract's cached_max is well
            # before the requested window's start (more than 30 days), the
            # contract's trading lifetime ended before the window — every
            # cold-start fetch will return zero rows but still cost ~1-3s
            # of GIL-holding parse time per contract, multiplied by ~25
            # expired contracts per asset on a wide rank-window splice.
            # That's the dominant cause of the 5-15 minute live-feed stall
            # on cold pre-warm.
            #
            # Replay safety: this only triggers when start > cached_max + 30d.
            # Replay queries during a contract's active period (or its expiry
            # month) always have start <= cached_max + 30d, so the normal
            # forward-fill path still runs. Verified against:
            #   • NGV4 (cached 2014-08..2014-10) replay of Sep-2014 → start
            #     2014-09 < cached_max+30d, normal fetch runs, splice sees
            #     real volumes.
            #   • NGV4 cold pre-warm for entry 2026-05 → start 2025-03,
            #     well past cached_max+30d, skip — correct (no Nov-2014
            #     volumes are relevant for a 2026 splice).
            expired_window = (
                cached_max is not None
                and start_ts > cached_max + pd.Timedelta(days=30)
            )

            # Track whether the forward-fill (if it ran) queried [start..end]
            # in full. When True, an empty slice afterwards already proves
            # this contract has no data in the window — re-issuing the same
            # request as a backfill below just costs another primary + fallback
            # round-trip per expired contract (the fallback 422s ~1-2s every
            # time). The decade-shift case the backfill exists for takes the
            # need_fetch=False path (cached_max is in the future relative to
            # end_ts), so this flag stays False there and the backfill still
            # runs as designed.
            forward_fill_covered_window = False

            if need_fetch and not expired_window:
                # Compute the missing tail. If completely cold, fetch the full
                # requested window; otherwise just the gap after cached_max.
                if cached_max is None:
                    fetch_start: datetime = start
                else:
                    next_after_cached = (cached_max + grace).to_pydatetime()
                    fetch_start = next_after_cached if next_after_cached > start else start
                if fetch_start <= start:
                    forward_fill_covered_window = True
                if fetch_start < end:
                    new_df = self._fetch_one(dataset, raw_symbol, schema,
                                              fetch_start, end)
                    used_fallback = False
                    if (new_df.empty and fallback_raw_symbol
                            and fallback_raw_symbol != raw_symbol):
                        new_df = self._fetch_one(dataset, fallback_raw_symbol,
                                                  schema, fetch_start, end)
                        used_fallback = True
                    if used_fallback:
                        logger.info("fetch fallback (rolling) %s %s [%s..%s]: %d rows",
                                    fallback_raw_symbol, schema,
                                    fetch_start.date(), end.date(), len(new_df))
                    else:
                        logger.info("fetch (rolling) %s %s [%s..%s]: %d rows",
                                    raw_symbol, schema,
                                    fetch_start.date(), end.date(), len(new_df))
                    if not new_df.empty:
                        new_df = self._ensure_utc(new_df)
                        if cached.empty:
                            merged = new_df
                        else:
                            merged = pd.concat([cached, new_df]).sort_index()
                            merged = merged[~merged.index.duplicated(keep="last")]
                        try:
                            self._atomic_write_parquet(merged, path)
                        except Exception as e:
                            logger.warning("rolling write failed for %s: %s", path, e)
                        cached = merged

            if cached.empty:
                return cached

            # Window-prefix backfill — see method docstring for context.
            # After forward-fill, check whether the cache covers the window
            # starting from `start`. If not, fetch only the missing prefix
            # so we don't re-pull rows we already have.
            sliced = cached[(cached.index >= start_ts) &
                            (cached.index <= end_ts)]
            backfill_end_dt: Optional[datetime] = None
            if sliced.empty:
                if forward_fill_covered_window or expired_window:
                    # Forward-fill already queried [start..end] and got
                    # nothing, OR the cache shows the contract's lifetime
                    # ended before this window (expired_window). Either
                    # way the backfill would just re-issue the same null
                    # query.
                    pass
                else:
                    # Cache holds rows but none in this window (decade-shift
                    # contamination, or multi-decade middle gap). Fetch the
                    # full requested window.
                    backfill_end_dt = end
            elif sliced.index.min() > start_ts + grace:
                # Cache covers a tail of the window but is missing a
                # prefix. Fetch only up to one grace-day before the
                # earliest in-window row, so the merge doesn't waste
                # credits re-pulling rows we already have.
                backfill_end_dt = (sliced.index.min() - grace).to_pydatetime()

            if backfill_end_dt is not None and start < backfill_end_dt:
                back_df = self._fetch_one(dataset, raw_symbol, schema,
                                           start, backfill_end_dt)
                used_fallback = False
                if (back_df.empty and fallback_raw_symbol
                        and fallback_raw_symbol != raw_symbol):
                    back_df = self._fetch_one(dataset, fallback_raw_symbol,
                                               schema, start, backfill_end_dt)
                    used_fallback = True
                if used_fallback:
                    logger.info("fetch fallback (rolling backfill) %s %s [%s..%s]: %d rows",
                                fallback_raw_symbol, schema,
                                start.date(), backfill_end_dt.date(), len(back_df))
                else:
                    logger.info("fetch (rolling backfill) %s %s [%s..%s]: %d rows",
                                raw_symbol, schema,
                                start.date(), backfill_end_dt.date(), len(back_df))
                if not back_df.empty:
                    back_df = self._ensure_utc(back_df)
                    merged = pd.concat([cached, back_df]).sort_index()
                    merged = merged[~merged.index.duplicated(keep="last")]
                    try:
                        self._atomic_write_parquet(merged, path)
                    except Exception as e:
                        logger.warning("rolling backfill write failed for %s: %s", path, e)
                    cached = merged

            return cached[(cached.index >= start_ts) &
                          (cached.index <= end_ts)]

    def fetch_ohlcv_1s(self, dataset: str, raw_symbol: str,
                       fallback_raw_symbol: Optional[str],
                       start: datetime, end: datetime) -> pd.DataFrame:
        return self.fetch(dataset, raw_symbol, fallback_raw_symbol, "ohlcv-1s", start, end)

    def fetch_ohlcv_1d(self, dataset: str, raw_symbol: str,
                       fallback_raw_symbol: Optional[str],
                       start: datetime, end: datetime) -> pd.DataFrame:
        return self.fetch(dataset, raw_symbol, fallback_raw_symbol, "ohlcv-1d", start, end)
