"""High-level orchestration: ingest, cache, build panel response.

Pulls Open-Meteo + NOAA AO data, persists to SQLite, computes the
hover panel response (HDD/CDD per region/horizon, basin freeze metrics,
AO + revision). Per the spec §6, ingestion is on-demand for Phase 1 — the
first hit per day pays the fetch cost (~2s with parallel fetches), every
subsequent hit is instant from the SQLite cache.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import logging
import sqlite3
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import ao as ao_mod
from . import compute, openmeteo
from . import openmeteo_historical as openmeteo_hist
from .openmeteo_historical import GFS_PREVIOUS_RUNS_START
from .regions import (
    BASINS, BASIN_COORDS, NATIONAL_STATES, REGIONS, STATE_COORDS,
)
from .compute import (
    HORIZONS, HORIZON_LABELS, MIN_BASELINE_N, build_region_panel,
    cdd, hdd, modified_z, n_day_min, n_day_sum, revision_n_day_sum, tavg,
)

logger = logging.getLogger("weather.service")

# ---------------------------------------------------------------------------
# SQLite plumbing
# ---------------------------------------------------------------------------

DEFAULT_DB_PATH = Path(__file__).parent / "weather_cache" / "weather.db"
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

# Phase 1: refetch if last fetch for `forecast_date` is older than this.
# Daily refresh — 12h gives us a reasonable buffer if the GFS 12Z run lands
# late or if the user opens the app outside US business hours.
STALE_AFTER = timedelta(hours=12)


class WeatherService:
    """Singleton-style service managing the weather cache + panel responses.

    Thread-safe enough for FastAPI's threadpool — uses a per-instance lock
    around ingestion so a burst of concurrent /weather calls doesn't trigger
    duplicate fetches.
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self.db_path = Path(db_path) if db_path else DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        (self.db_path.parent / "raw").mkdir(parents=True, exist_ok=True)
        self._init_schema()
        self._ingest_lock = threading.Lock()

    # ---- Schema --------------------------------------------------------

    def _init_schema(self) -> None:
        sql = SCHEMA_PATH.read_text()
        with self._conn() as conn:
            conn.executescript(sql)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        # WAL keeps reads non-blocking while ingestion is writing.
        conn.execute("PRAGMA journal_mode=WAL;")
        return conn

    # ---- Ingestion ----------------------------------------------------

    def ensure_ingested_for(self, forecast_date: date) -> None:
        """If we don't already have this vintage, fetch it.

        Routes by date:
          - today           → Open-Meteo Forecast API (live, forward-14d)
          - 2021-04..today-1 → Open-Meteo Previous Runs API (true issuance-anchored)
          - before 2021-04  → no-op (panel renders "—" + Phase 3 note)

        For historical dates, we ALSO ingest `forecast_date − 1` after the
        primary ingestion. The day-over-day revision math (spec §4.5) is
        apples-to-apples on target dates between two consecutive vintages, so
        without yesterday's vintage cached the entire Δ + Z column comes back
        as `—`. The extra ingestion adds ~7s to the first hover for any new
        date but pays off immediately — every revision cell populates.

        See docs/weather-data-spec.md §3 sources A and B for the data
        contract, and §10 for what's still deferred.
        """
        today = _today_utc()
        if forecast_date > today:
            # Future-dated hover (shouldn't happen on a real chart, but
            # defensive): nothing to do.
            return
        if forecast_date < GFS_PREVIOUS_RUNS_START:
            # Pre-2021-04: requires GRIB2 ETL (spec §10 Phase 3). Cache has
            # whatever earlier ingestion runs persisted; we don't fetch.
            return

        self._ingest_one(forecast_date, today)
        # Pair-up with yesterday for revision math, but only for historical
        # dates. Today's revision uses yesterday's vintage that's already in
        # the cache from yesterday's run; we don't backfill it from here.
        if forecast_date != today:
            yesterday = forecast_date - timedelta(days=1)
            if yesterday >= GFS_PREVIOUS_RUNS_START:
                self._ingest_one(yesterday, today)

    def _ingest_one(self, forecast_date: date, today: date) -> None:
        """Single-vintage ingestion path with lock + idempotency. Used by
        both the user-requested vintage and the revision-neighbor backfill."""
        if self._has_vintage(forecast_date):
            if forecast_date != today or not self._is_stale(forecast_date):
                return

        with self._ingest_lock:
            # Re-check inside the lock — another thread may have ingested
            # while we were waiting.
            if self._has_vintage(forecast_date):
                if forecast_date != today or not self._is_stale(forecast_date):
                    return
            logger.info("weather: ingesting forecasts for %s", forecast_date)
            if forecast_date == today:
                self._ingest_now(forecast_date)
            else:
                self._ingest_historical(forecast_date)

    def _coverage_note(self, forecast_date: date,
                       available: bool) -> Optional[str]:
        """User-facing note shown in the panel footer.

        - today: no note (full 14-day live forecast).
        - 2021-04 .. yesterday: Open-Meteo Previous Runs (GFS short-range
          archive, leads 0–7d → 10D/14D cells render `—`).
        - pre-2021-04 with data: GRIB backfill present (GEFS Reforecast,
          ensemble mean; same 0–7d effective coverage).
        - pre-2021-04 without data: backfill not yet run for this date.
        """
        today = _today_utc()
        if forecast_date == today:
            return None
        if forecast_date >= GFS_PREVIOUS_RUNS_START:
            return (
                "Vintage source: Open-Meteo Previous Runs (GFS short-range "
                "archive). Leads 0–7d available; 10D / 14D cells will be — "
                "for this issuance."
            )
        # Pre-2021-04 — served from the GRIB backfill if it's been run.
        if available:
            return (
                "Vintage source: GEFS Reforecast v12 (GRIB backfill). Leads "
                "0–7d available; 10D / 14D cells will be — for this issuance."
            )
        return (
            "Vintage forecasts before 2021-04-01 come from the GRIB backfill "
            "(scripts/grib_backfill/) — not yet run for this date. Cells "
            "render — until then. See docs/weather-data-spec.md §10."
        )

    def _has_vintage(self, forecast_date: date) -> bool:
        """True if we have ANY forecast_daily rows for this issuance date."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM forecast_daily WHERE forecast_date=? LIMIT 1",
                (forecast_date.isoformat(),),
            ).fetchone()
        return row is not None

    def _is_stale(self, forecast_date: date) -> bool:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT MAX(fetched_at) AS last "
                "FROM raw_fetches WHERE source='openmeteo'"
            ).fetchone()
        last_str = row["last"] if row else None
        if last_str is None:
            return True
        try:
            last = datetime.fromisoformat(last_str)
        except ValueError:
            return True
        return (datetime.now(timezone.utc) - last) > STALE_AFTER

    def _ingest_now(self, forecast_date: date) -> None:
        """Parallel fetch via Open-Meteo Forecast API for the LIVE vintage
        (issued today, looking forward 14 days). See _ingest_historical for
        past issuance dates."""
        self._parallel_ingest(
            forecast_date,
            fetcher=lambda lat, lon: openmeteo.fetch_daily_temps(lat, lon),
            source="openmeteo",
        )
        # AO is current+forecast — only meaningful for today's ingestion.
        try:
            self._ingest_ao(forecast_date)
        except Exception as e:
            # AO ingestion failing shouldn't block the panel — Open-Meteo data
            # is the bulk of value. Log and continue; AO cells will render `—`.
            logger.warning("AO ingestion failed: %s", e)

    def _ingest_historical(self, forecast_date: date) -> None:
        """Parallel fetch via Open-Meteo Previous Runs API for a PAST issuance
        date. Returns issuance-anchored vintage forecasts at leads 0..7 days
        (GFS short-range archive). Leads 8..14 are not stored upstream, so
        those horizons render `—` in the panel — see spec §3 source B."""
        self._parallel_ingest(
            forecast_date,
            fetcher=lambda lat, lon: openmeteo_hist.fetch_vintage_daily(
                lat, lon, forecast_date,
            ),
            source="openmeteo_previous_runs",
        )

    def _parallel_ingest(
        self,
        forecast_date: date,
        fetcher,  # Callable[[float, float], Dict[date, Tuple[float, float]]]
        source: str,
    ) -> None:
        """Common parallel-fetch + persist logic, shared by live and historical
        ingestion paths. Same 57-coord fan-out; only the `fetcher` callable
        differs (which Open-Meteo endpoint to hit).

        One transaction wraps the inserts so a partial write can't leave the
        cache in a halfway state. If more than half the fetches fail (likely a
        network or provider outage), we abort the entire ingestion rather than
        polluting the cache with a half-empty vintage.
        """
        # Build the (label, lat, lon) work list once. Labels are
        # `state:XX` for states and `basin:NAME:i` for basin points (i = 0..2).
        jobs: List[Tuple[str, float, float]] = []
        for s in NATIONAL_STATES:
            lat, lon = STATE_COORDS[s]
            jobs.append((f"state:{s}", lat, lon))
        for b, points in BASIN_COORDS.items():
            for i, (lat, lon) in enumerate(points):
                jobs.append((f"basin:{b}:{i}", lat, lon))

        # 8 workers — Open-Meteo handles parallel cleanly and we don't want
        # to be a bad citizen of a free service.
        results: Dict[str, Dict[date, Tuple[float, float]]] = {}
        errors: List[Tuple[str, str]] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            future_to_label = {
                ex.submit(fetcher, lat, lon): label
                for label, lat, lon in jobs
            }
            for fut in concurrent.futures.as_completed(future_to_label):
                label = future_to_label[fut]
                try:
                    results[label] = fut.result()
                except Exception as e:
                    errors.append((label, f"{type(e).__name__}: {e}"))
                    logger.warning("%s fetch failed for %s: %s",
                                   source, label, e)

        if errors and len(errors) > len(jobs) * 0.5:
            raise RuntimeError(
                f"{source}: {len(errors)}/{len(jobs)} fetches failed; aborting "
                f"ingestion. Sample: {errors[:3]}"
            )

        rows: List[Tuple[str, str, str, str, float, str]] = []
        for label, daily in results.items():
            region = label  # `state:XX` / `basin:NAME:i` / etc.
            for d, (tmax, tmin) in daily.items():
                ta = tavg(tmax, tmin)
                rows.append((forecast_date.isoformat(), d.isoformat(),
                             region, "tmax", float(tmax), source))
                rows.append((forecast_date.isoformat(), d.isoformat(),
                             region, "tmin", float(tmin), source))
                rows.append((forecast_date.isoformat(), d.isoformat(),
                             region, "tavg", float(ta), source))
                # State HDD/CDD persisted at the state level so region
                # aggregation can re-compute deterministically; basin points
                # don't need HDD/CDD (we use Tmin directly for freeze risk).
                if label.startswith("state:"):
                    rows.append((forecast_date.isoformat(), d.isoformat(),
                                 region, "hdd", float(hdd(ta)), source))
                    rows.append((forecast_date.isoformat(), d.isoformat(),
                                 region, "cdd", float(cdd(ta)), source))

        with self._conn() as conn:
            conn.execute("BEGIN")
            try:
                conn.executemany(
                    "INSERT OR REPLACE INTO forecast_daily "
                    "(forecast_date, target_date, region, metric, value, source) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    rows,
                )
                conn.execute(
                    "INSERT OR REPLACE INTO raw_fetches "
                    "(fetched_at, source, url, sha256, bytes, path) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (datetime.now(timezone.utc).isoformat(),
                     source,
                     "batch:" + forecast_date.isoformat(),
                     hashlib.sha256(
                         (source + forecast_date.isoformat()).encode()
                     ).hexdigest(),
                     0, ""),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def _ingest_ao(self, forecast_date: date) -> None:
        observed = ao_mod.fetch_observed_ao()
        try:
            vintages = ao_mod.fetch_forecast_ao()
        except Exception as e:
            logger.warning("AO forecast fetch failed: %s", e)
            vintages = {}

        rows: List[Tuple[str, str, float, str]] = []
        for d, v in observed.items():
            rows.append((d.isoformat(), d.isoformat(), float(v), "observed"))
        # The NOAA AO forecast file contains ~120 vintages in one fetch — one
        # per `issued` date with its own 0-15 day lead forecasts. We persist
        # ALL vintages so day-over-day revision history is populated from a
        # single ingestion run rather than building up day-by-day.
        for issued, by_target in vintages.items():
            for target, v in by_target.items():
                rows.append((issued.isoformat(), target.isoformat(),
                             float(v), "forecast_gfs"))

        with self._conn() as conn:
            conn.executemany(
                "INSERT OR REPLACE INTO ao_daily "
                "(forecast_date, target_date, value, kind) "
                "VALUES (?, ?, ?, ?)",
                rows,
            )

    # ---- Panel build --------------------------------------------------

    def build_panel(self, forecast_date: date) -> Dict[str, Any]:
        """Return the full panel response for `forecast_date`.

        If we have no ingested forecasts for `forecast_date`, the cells
        render as `None` and the response includes an `available: false`
        flag the frontend uses to show the "vintage data not ingested"
        message (spec §7).
        """
        # State HDD/CDD dailies for THIS vintage.
        state_hdd = self._load_state_metric(forecast_date, "hdd")
        state_cdd = self._load_state_metric(forecast_date, "cdd")
        available = bool(state_hdd) or bool(state_cdd)

        regions_panel = build_region_panel(forecast_date, state_hdd, state_cdd)

        # Day-over-day revision: same metric, but issued yesterday for the
        # SAME target dates. Spec §4.5.
        ystr = (forecast_date - timedelta(days=1))
        y_state_hdd = self._load_state_metric(ystr, "hdd")
        y_state_cdd = self._load_state_metric(ystr, "cdd")
        revisions = self._compute_revisions(
            forecast_date, state_hdd, state_cdd, y_state_hdd, y_state_cdd,
        )

        # Modified Z-scores per (region, horizon) using the historical
        # revision distribution. Spec §4.6. We pool all eras for Phase 1
        # since vintage backfill is deferred — once that lands, switch to
        # per-(region, horizon, week, era) baselines.
        z_scores = self._compute_z_scores(forecast_date, revisions)

        # Basins: minimum forecast Tmin across each window.
        basins = self._build_basin_panel(forecast_date)

        # AO snapshot.
        ao_snapshot = self._build_ao_panel(forecast_date)

        return {
            "forecast_date": forecast_date.isoformat(),
            "available": available,
            "regions": regions_panel,
            "revisions": revisions,
            "z_scores": z_scores,
            "basins": basins,
            "ao": ao_snapshot,
            "phase1_note": self._coverage_note(forecast_date, available),
        }

    def _load_state_metric(
        self, forecast_date: date, metric: str,
    ) -> Dict[str, Dict[date, float]]:
        """{state: {target_date: value}} for one (vintage, metric)."""
        prefix = "state:"
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT region, target_date, value "
                "FROM forecast_daily "
                "WHERE forecast_date=? AND metric=? AND region LIKE ?",
                (forecast_date.isoformat(), metric, prefix + "%"),
            ).fetchall()
        out: Dict[str, Dict[date, float]] = {}
        for r in rows:
            state = r["region"][len(prefix):]
            try:
                d = datetime.strptime(r["target_date"], "%Y-%m-%d").date()
            except ValueError:
                continue
            out.setdefault(state, {})[d] = float(r["value"])
        return out

    def _compute_revisions(
        self,
        forecast_date: date,
        today_hdd: Dict[str, Dict[date, float]],
        today_cdd: Dict[str, Dict[date, float]],
        y_hdd: Dict[str, Dict[date, float]],
        y_cdd: Dict[str, Dict[date, float]],
    ) -> Dict[str, Dict[str, Dict[str, Optional[float]]]]:
        """{region: {horizon_label: {hdd: Δ, cdd: Δ}}} apples-to-apples."""
        # Aggregate to region dailies for both vintages, then revision = N-day
        # sum diff anchored on identical target dates.
        out: Dict[str, Dict[str, Dict[str, Optional[float]]]] = {}
        for region in REGIONS:
            today_h = _region_dailies(region, today_hdd)
            today_c = _region_dailies(region, today_cdd)
            yest_h = _region_dailies(region, y_hdd)
            yest_c = _region_dailies(region, y_cdd)

            per_horizon: Dict[str, Dict[str, Optional[float]]] = {}
            for n in HORIZONS:
                label = HORIZON_LABELS[n]
                if n == 1:
                    target_start = forecast_date
                    window = 1
                else:
                    target_start = forecast_date + timedelta(days=1)
                    window = n
                per_horizon[label] = {
                    "hdd": revision_n_day_sum(today_h, yest_h, target_start, window),
                    "cdd": revision_n_day_sum(today_c, yest_c, target_start, window),
                }
            out[region] = per_horizon
        return out

    def _compute_z_scores(
        self,
        forecast_date: date,
        revisions: Dict[str, Dict[str, Dict[str, Optional[float]]]],
    ) -> Dict[str, Dict[str, Dict[str, Optional[float]]]]:
        """Modified Z-score for each (region, horizon, hdd|cdd).

        Baseline = the historical revision distribution for the same
        (region, horizon, metric). Phase 1 pools all dates; spec §4.6 will
        narrow to (region, horizon, week-of-year, era) once vintage backfill
        lands and seasonal MAD is meaningful.
        """
        baselines = self._historical_revisions(forecast_date)
        out: Dict[str, Dict[str, Dict[str, Optional[float]]]] = {}
        for region, per_horizon in revisions.items():
            out[region] = {}
            for horizon_label, mh in per_horizon.items():
                cell: Dict[str, Optional[float]] = {}
                for metric in ("hdd", "cdd"):
                    val = mh[metric]
                    base = baselines.get((region, horizon_label, metric), [])
                    if val is None:
                        cell[metric] = None
                    else:
                        cell[metric] = modified_z(val, base)
                out[region][horizon_label] = cell
        return out

    def _historical_revisions(
        self, forecast_date: date,
    ) -> Dict[Tuple[str, str, str], List[float]]:
        """Compute every prior-vintage revision we can reconstruct from the
        cache, grouped by (region, horizon_label, metric).

        For Phase 1 with on-demand ingestion this distribution is small (one
        observation per day of operation). Z-scores will gate themselves on
        len < MIN_BASELINE_N (compute.py) and emit None until the cache has
        ~30 days of history. This is documented in the spec §4.6.
        """
        # Collect all distinct forecast_dates in the cache.
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT DISTINCT forecast_date FROM forecast_daily "
                "WHERE forecast_date < ? AND metric='hdd' "
                "ORDER BY forecast_date ASC",
                (forecast_date.isoformat(),),
            ).fetchall()

        baselines: Dict[Tuple[str, str, str], List[float]] = {}
        prev_date: Optional[date] = None
        prev_hdd: Optional[Dict[str, Dict[date, float]]] = None
        prev_cdd: Optional[Dict[str, Dict[date, float]]] = None

        for r in rows:
            try:
                d = datetime.strptime(r["forecast_date"], "%Y-%m-%d").date()
            except ValueError:
                continue
            if prev_date is None or prev_hdd is None:
                # Need TWO consecutive vintages to compute one revision; skip
                # the first iteration and just stash for next loop.
                prev_date = d
                prev_hdd = self._load_state_metric(d, "hdd")
                prev_cdd = self._load_state_metric(d, "cdd")
                continue

            # Skip non-consecutive days (we can only compute true day-over-day
            # revisions when both vintages are adjacent).
            if d - prev_date != timedelta(days=1):
                prev_date = d
                prev_hdd = self._load_state_metric(d, "hdd")
                prev_cdd = self._load_state_metric(d, "cdd")
                continue

            cur_hdd = self._load_state_metric(d, "hdd")
            cur_cdd = self._load_state_metric(d, "cdd")

            for region in REGIONS:
                for n in HORIZONS:
                    label = HORIZON_LABELS[n]
                    if n == 1:
                        target_start = d
                        window = 1
                    else:
                        target_start = d + timedelta(days=1)
                        window = n
                    cur_h_daily = _region_dailies(region, cur_hdd)
                    pre_h_daily = _region_dailies(region, prev_hdd)
                    cur_c_daily = _region_dailies(region, cur_cdd)
                    pre_c_daily = _region_dailies(region, prev_cdd)
                    rh = revision_n_day_sum(cur_h_daily, pre_h_daily,
                                            target_start, window)
                    rc = revision_n_day_sum(cur_c_daily, pre_c_daily,
                                            target_start, window)
                    if rh is not None:
                        baselines.setdefault((region, label, "hdd"), []).append(rh)
                    if rc is not None:
                        baselines.setdefault((region, label, "cdd"), []).append(rc)

            prev_date, prev_hdd, prev_cdd = d, cur_hdd, cur_cdd

        return baselines

    def _build_basin_panel(self, forecast_date: date) -> Dict[str, Any]:
        """{basin: {horizon_label: tmin_min}} for the basin freeze panel.

        Horizons here are different from the HDD/CDD ones (spec §1):
        Now / 5D / 10D / 14D — minimum Tmin across the window.
        """
        out: Dict[str, Any] = {}
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT region, target_date, value "
                "FROM forecast_daily "
                "WHERE forecast_date=? AND metric='tmin' AND region LIKE 'basin:%'",
                (forecast_date.isoformat(),),
            ).fetchall()

        # Build {basin: {target_date: [tmin_p0, tmin_p1, tmin_p2]}}
        per_basin: Dict[str, Dict[date, List[float]]] = {}
        for r in rows:
            label = r["region"]                # 'basin:permian:0' etc.
            try:
                _, basin, _i = label.split(":")
            except ValueError:
                continue
            try:
                d = datetime.strptime(r["target_date"], "%Y-%m-%d").date()
            except ValueError:
                continue
            per_basin.setdefault(basin, {}).setdefault(d, []).append(float(r["value"]))

        # Mean across the 3 points to get basin-level Tmin per day.
        basin_dailies: Dict[str, Dict[date, float]] = {}
        for basin, by_date in per_basin.items():
            for d, vals in by_date.items():
                basin_dailies.setdefault(basin, {})[d] = sum(vals) / len(vals)

        BASIN_HORIZONS = (1, 5, 10, 14)
        BASIN_LABELS = {1: "Now", 5: "5D", 10: "10D", 14: "14D"}
        for basin in BASINS:
            cells: Dict[str, Optional[float]] = {}
            daily = basin_dailies.get(basin, {})
            for n in BASIN_HORIZONS:
                label = BASIN_LABELS[n]
                if n == 1:
                    cells[label] = daily.get(forecast_date)
                else:
                    cells[label] = n_day_min(
                        daily, forecast_date + timedelta(days=1), n,
                    )
            out[basin] = cells
        return out

    def _build_ao_panel(self, forecast_date: date) -> Dict[str, Any]:
        """Current AO + day-over-day revision + Z-score on revisions."""
        with self._conn() as conn:
            obs_row = conn.execute(
                "SELECT value FROM ao_daily WHERE target_date<=? AND kind='observed' "
                "ORDER BY target_date DESC LIMIT 1",
                (forecast_date.isoformat(),),
            ).fetchone()
        ao_now = float(obs_row["value"]) if obs_row else None

        # Revision: today's forecast for `forecast_date+1` minus yesterday's
        # forecast for the same target date. Same apples-to-apples logic as
        # HDD/CDD. We use the +1 target because forecasting today is moot.
        target = forecast_date + timedelta(days=1)
        with self._conn() as conn:
            t_row = conn.execute(
                "SELECT value FROM ao_daily "
                "WHERE forecast_date=? AND target_date=? AND kind='forecast_gfs'",
                (forecast_date.isoformat(), target.isoformat()),
            ).fetchone()
            y_row = conn.execute(
                "SELECT value FROM ao_daily "
                "WHERE forecast_date=? AND target_date=? AND kind='forecast_gfs'",
                ((forecast_date - timedelta(days=1)).isoformat(),
                 target.isoformat()),
            ).fetchone()

        revision = (None if (t_row is None or y_row is None)
                    else float(t_row["value"]) - float(y_row["value"]))

        # Z baseline: every (forecast_date d, target_date d+1) revision we
        # can compute from cache.
        baseline = self._ao_revision_baseline(forecast_date)
        z = modified_z(revision, baseline) if revision is not None else None

        return {
            "now": ao_now,
            "revision": revision,
            "z": z,
            "baseline_n": len(baseline),
        }

    def _ao_revision_baseline(self, forecast_date: date) -> List[float]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT forecast_date, target_date, value FROM ao_daily "
                "WHERE kind='forecast_gfs' AND forecast_date < ? "
                "ORDER BY forecast_date ASC, target_date ASC",
                (forecast_date.isoformat(),),
            ).fetchall()
        # Group by forecast_date, collect "next-day" forecasts, then diff
        # consecutive forecast_dates for the same +1 lead.
        by_date: Dict[date, Dict[date, float]] = {}
        for r in rows:
            try:
                fd = datetime.strptime(r["forecast_date"], "%Y-%m-%d").date()
                td = datetime.strptime(r["target_date"], "%Y-%m-%d").date()
            except ValueError:
                continue
            by_date.setdefault(fd, {})[td] = float(r["value"])

        out: List[float] = []
        sorted_fds = sorted(by_date.keys())
        for i in range(1, len(sorted_fds)):
            fd, prev_fd = sorted_fds[i], sorted_fds[i - 1]
            if fd - prev_fd != timedelta(days=1):
                continue
            target = fd + timedelta(days=1)
            cur_v = by_date[fd].get(target)
            prev_v = by_date[prev_fd].get(target)
            if cur_v is None or prev_v is None:
                continue
            out.append(cur_v - prev_v)
        return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _region_dailies(
    region: str,
    state_dailies: Dict[str, Dict[date, float]],
) -> Dict[date, float]:
    """Aggregate per-state {date: value} dicts into per-region {date: value}.

    Uses population weighting per regions.py. Skips dates where no states in
    the region have data. (Matches compute.aggregate_region's missing-data
    semantics.)
    """
    states = REGIONS.get(region, [])
    target_dates = set()
    for s in states:
        target_dates.update(state_dailies.get(s, {}).keys())
    out: Dict[date, float] = {}
    for d in target_dates:
        sv = {s: state_dailies.get(s, {}).get(d) for s in states}
        sv = {k: v for k, v in sv.items() if v is not None}
        agg = compute.aggregate_region(region, sv)
        if agg is not None:
            out[d] = agg
    return out


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()
