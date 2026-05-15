"""One-time GRIB backfill — Phase A (download) + Phase B (extract) combined.

For each forecast issuance date in a range:
  1. download the source's 2m-temperature GRIB file(s) for that cycle
  2. extract the 57 sample points (states + basins) at every forecast timestep
  3. (if multi-member) average to the ensemble mean
  4. bucket timesteps into America/Chicago calendar days; take daily Tmax/Tmin
  5. write a small Parquet: forecast_date | target_date | coord_label | tmax_f | tmin_f

Downloaded GRIB files go to a temp file and are deleted immediately after
extraction — no staging directory to manage, ~0 disk overhead beyond the
~60 MB transient. The Parquet output (a few KB per cycle) is the durable
artifact; phase C (import_to_db.py) loads it into the SQLite cache.

Resumable: a cycle whose Parquet already exists is skipped. So you can
Ctrl-C and re-run; it picks up where it left off.

Usage:
    pip install -r scripts/grib_backfill/requirements.txt
    python -m scripts.grib_backfill.backfill \
        --source gefs_reforecast --start 2010-01-01 --end 2019-12-31
    # then:
    python -m scripts.grib_backfill.import_to_db --source gefs_reforecast

Options:
    --members all|control   (gefs_reforecast only) ensemble mean of 5 members
                            vs control run only. Default: all (ensemble mean).
                            'control' is ~1/5 the download.
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import warnings

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)
import xarray as xr  # noqa: E402

# Local imports (this module is meant to be run as `python -m scripts.grib_backfill.backfill`).
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import grib_common as gc                      # noqa: E402
import source_gefs_reforecast as gefs         # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("backfill")

USER_AGENT = "trade-chart-grib-backfill/0.1"
DOWNLOAD_TIMEOUT_S = 300       # 60 MB files; generous
DOWNLOAD_RETRIES = [5, 15, 45]  # seconds between attempts

# Transient download workspace. Holds at most ONE GRIB file (~60 MB) at a
# time — each member file is deleted immediately after its values are
# extracted. Wiped clean at the start of every run, so a previous hard-kill
# can't leave anything stranded. Gitignored.
STAGING_DIR = _HERE / "staging"


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def _download(url: str, dest: Path) -> bool:
    """Download `url` to `dest` with retries + a content-length sanity check.

    Returns True on success, False if all retries failed (caller decides
    whether a missing member is fatal). A 404 is treated as permanent — no
    retries — because some early reforecast cycles may legitimately be
    absent.
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt, sleep_s in enumerate([0] + DOWNLOAD_RETRIES):
        if sleep_s:
            time.sleep(sleep_s)
        try:
            with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp:
                expected = resp.headers.get("Content-Length")
                expected = int(expected) if expected else None
                data = resp.read()
            if expected is not None and len(data) != expected:
                log.warning("size mismatch for %s: got %d, expected %d (retry)",
                            url, len(data), expected)
                continue
            dest.write_bytes(data)
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                log.info("404 (absent): %s", url)
                return False
            log.warning("HTTP %s for %s (attempt %d)", e.code, url, attempt + 1)
        except (urllib.error.URLError, TimeoutError) as e:
            log.warning("network error for %s: %s (attempt %d)", url, e, attempt + 1)
    log.error("giving up on %s after %d attempts", url, len(DOWNLOAD_RETRIES) + 1)
    return False


# ---------------------------------------------------------------------------
# Extract a member's 57-point timeseries from a GEFS tmp_2m GRIB file
# ---------------------------------------------------------------------------

def _extract_member(grib_path: Path,
                    points: List[Tuple[str, float, float]]
                    ) -> Tuple[List[datetime], np.ndarray]:
    """Open a tmp_2m GRIB file; return (valid_times_utc, temps_K).

    temps_K has shape (n_steps, n_points) — temperature in Kelvin at each
    forecast timestep for each of the 57 sample points (nearest grid cell).

    The GEFS grid is 0.25° with longitudes 0..360, so we wrap our
    -180..180 longitudes with `% 360` before the nearest-neighbour lookup.
    """
    # indexpath='' disables cfgrib's sidecar .idx cache (would litter temp dir
    # and can hit permission issues there).
    ds = xr.open_dataset(grib_path, engine="cfgrib",
                         backend_kwargs={"indexpath": ""})
    try:
        var = ds["t2m"]            # 2 m temperature, Kelvin, dims (step, lat, lon)
        lats = xr.DataArray([lat for _, lat, _ in points], dims="point")
        lons = xr.DataArray([lon % 360.0 for _, _, lon in points], dims="point")
        sel = var.sel(latitude=lats, longitude=lons, method="nearest")
        # sel dims: (step, point). Pull as a plain numpy array.
        temps_k = np.asarray(sel.values, dtype=np.float64)   # (n_steps, n_points)
        vt = np.asarray(ds["valid_time"].values)             # datetime64[ns], UTC
        valid_times = [
            datetime.fromtimestamp(t.astype("datetime64[s]").astype(int), tz=timezone.utc)
            for t in vt
        ]
        return valid_times, temps_k
    finally:
        ds.close()


# ---------------------------------------------------------------------------
# Per-cycle pipeline
# ---------------------------------------------------------------------------

def _process_cycle(issuance_date: date, members: List[str]) -> Optional[pd.DataFrame]:
    """Download + extract every member, ensemble-mean, daily-aggregate.

    Members are processed one at a time: download (~60 MB) → extract the 57
    points → delete the file → next member. So peak disk for the whole
    pipeline is ~60 MB transient, regardless of how many members or how long
    the run is. (Bandwidth is the bottleneck, not disk or CPU, so there's no
    point downloading members in parallel — same total bytes over the same
    pipe.)

    Returns a DataFrame with columns gc.PARQUET_COLUMNS, or None if no member
    could be obtained for this cycle.
    """
    points = gc.sample_points()

    sum_temps: Optional[np.ndarray] = None    # (n_steps, n_points), running Kelvin sum
    valid_times: Optional[List[datetime]] = None
    n_used = 0

    for member in members:
        url = gefs.grib_url(issuance_date, member)
        grib_path = STAGING_DIR / f"{issuance_date.isoformat()}_{member}.grib2"
        try:
            if not _download(url, grib_path):
                continue
            vt, temps_k = _extract_member(grib_path, points)
        except Exception as e:
            log.warning("extract failed for %s member %s: %s", issuance_date, member, e)
            continue
        finally:
            try:
                grib_path.unlink()
            except OSError:
                pass

        if valid_times is None:
            valid_times = vt
            sum_temps = temps_k.copy()
        else:
            # All members of a cycle share the same forecast hours; guard
            # against a malformed file rather than silently misaligning.
            if temps_k.shape != sum_temps.shape:
                log.warning("shape mismatch for %s member %s: %s vs %s — skipping member",
                            issuance_date, member, temps_k.shape, sum_temps.shape)
                continue
            sum_temps += temps_k
        n_used += 1

    if sum_temps is None or valid_times is None or n_used == 0:
        return None

    mean_temps_k = sum_temps / n_used         # (n_steps, n_points), ensemble mean
    mean_temps_f = gc.kelvin_to_fahrenheit(mean_temps_k)

    # Bucket timesteps into America/Chicago calendar days; take daily Tmax/Tmin
    # per (coord, target day) from the timesteps in that bucket. Drop the
    # pre-issuance partial day and any edge day with too few samples.
    central_dates = [gc.utc_to_central_date(vt) for vt in valid_times]
    rows: List[dict] = []
    for j, (coord_label, _lat, _lon) in enumerate(points):
        by_day: Dict[date, List[float]] = defaultdict(list)
        for i, cd in enumerate(central_dates):
            by_day[cd].append(float(mean_temps_f[i, j]))
        for cd, temps in sorted(by_day.items()):
            if cd < issuance_date:
                continue                       # pre-issuance partial — irrelevant
            if len(temps) < gc.MIN_SAMPLES_PER_DAY:
                continue                       # partial edge day — not a real extreme
            rows.append({
                "forecast_date": issuance_date.isoformat(),
                "target_date": cd.isoformat(),
                "coord_label": coord_label,
                "tmax_f": max(temps),
                "tmin_f": min(temps),
            })

    if not rows:
        return None
    return pd.DataFrame(rows, columns=gc.PARQUET_COLUMNS)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _date_range(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="One-time GRIB backfill (download + extract). Resumable: "
                    "re-run the same command and it skips cycles already done.")
    ap.add_argument("--source", default="gefs_reforecast",
                    choices=["gefs_reforecast"],
                    help="Archive source (only gefs_reforecast wired so far).")
    ap.add_argument("--start", required=True, help="First issuance date YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="Last issuance date YYYY-MM-DD (inclusive)")
    ap.add_argument("--members", default=os.environ.get("BACKFILL_MEMBERS", "control"),
                    choices=["control", "all"],
                    help="gefs_reforecast: 'control' = the unperturbed c00 run "
                         "only (1 file/cycle, ~1/5 the download — DEFAULT, fits "
                         "an overnight run); 'all' = ensemble mean of 5 members "
                         "(more skillful/smoother but ~5x the download).")
    ap.add_argument("--force", action="store_true",
                    help="Re-download + re-extract even if a cycle's Parquet "
                         "already exists (use to switch --members modes).")
    args = ap.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d").date()
    end = datetime.strptime(args.end, "%Y-%m-%d").date()
    if end < start:
        ap.error("--end must be >= --start")

    if args.source == "gefs_reforecast":
        members = gefs.members_for(args.members)
        in_coverage = gefs.in_coverage
        log.info("GEFS Reforecast backfill %s..%s, members=%s%s",
                 start, end, members, " (--force)" if args.force else "")
    else:
        ap.error(f"source {args.source} not implemented")

    # Fresh staging dir each run — guarantees no leftover GRIB files from a
    # previous hard-kill. Peak disk during the run is ~60 MB (one member file).
    if STAGING_DIR.exists():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
    STAGING_DIR.mkdir(parents=True, exist_ok=True)

    done = skipped = failed = 0
    try:
        for issuance in _date_range(start, end):
            if not in_coverage(issuance):
                log.info("skip %s: outside source coverage", issuance)
                skipped += 1
                continue
            out_path = gc.extracted_path(args.source, issuance)
            if out_path.exists() and not args.force:
                skipped += 1
                continue
            t0 = time.time()
            df = _process_cycle(issuance, members)
            if df is None:
                log.warning("no data extracted for %s", issuance)
                failed += 1
                continue
            # Atomic write: temp file then rename, so a Ctrl-C mid-write
            # doesn't leave a truncated Parquet the resume check would skip.
            tmp_out = out_path.with_suffix(".parquet.tmp")
            df.to_parquet(tmp_out, index=False)
            tmp_out.replace(out_path)
            done += 1
            log.info("%s: %d rows -> %s (%.1fs)", issuance, len(df),
                     out_path.name, time.time() - t0)
    finally:
        # Wipe the staging dir on the way out (normal exit OR Ctrl-C).
        shutil.rmtree(STAGING_DIR, ignore_errors=True)

    log.info("backfill done: %d cycles written, %d skipped, %d failed",
             done, skipped, failed)
    log.info("next: python scripts/grib_backfill/import_to_db.py --source %s",
             args.source)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
