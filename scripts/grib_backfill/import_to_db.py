"""Phase C — load extracted Parquet into the live SQLite weather cache.

Reads scripts/grib_backfill/extracted/<source>/*.parquet (Phase B output) and
INSERT-OR-REPLACEs rows into the `forecast_daily` table of
server/weather/weather_cache/weather.db — the SAME table the live Open-Meteo
ingestion writes to and the /weather endpoint reads from.

For each Parquet row (forecast_date, target_date, coord_label, tmax_f, tmin_f)
we emit the same per-metric rows the live path does:
  - tmax, tmin, tavg                          (all coords)
  - hdd, cdd  (derived via server.weather.compute)   (state coords only)
HDD/CDD math stays in compute.py — this script never reimplements it.

Idempotent: re-running overwrites the same primary keys (forecast_date,
target_date, region, metric). Safe to run after every backfill chunk.

Usage:
    python -m scripts.grib_backfill.import_to_db --source gefs_reforecast
    # or limit to a date range:
    python -m scripts.grib_backfill.import_to_db --source gefs_reforecast \
        --start 2015-01-01 --end 2015-12-31
"""
from __future__ import annotations

import argparse
import logging
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

import pandas as pd

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import grib_common as gc                       # noqa: E402  (sets up sys.path for `server`)

from server.weather.compute import cdd, hdd, tavg        # noqa: E402
from server.weather.service import DEFAULT_DB_PATH       # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("import_to_db")

INSERT_SQL = (
    "INSERT OR REPLACE INTO forecast_daily "
    "(forecast_date, target_date, region, metric, value, source) "
    "VALUES (?, ?, ?, ?, ?, ?)"
)


def _rows_for(df: pd.DataFrame, source: str) -> List[Tuple[str, str, str, str, float, str]]:
    """Expand a Parquet DataFrame into forecast_daily tuples."""
    out: List[Tuple[str, str, str, str, float, str]] = []
    for r in df.itertuples(index=False):
        fd, td, region = r.forecast_date, r.target_date, r.coord_label
        tmax = float(r.tmax_f)
        tmin = float(r.tmin_f)
        ta = tavg(tmax, tmin)
        out.append((fd, td, region, "tmax", tmax, source))
        out.append((fd, td, region, "tmin", tmin, source))
        out.append((fd, td, region, "tavg", ta, source))
        if region.startswith("state:"):
            out.append((fd, td, region, "hdd", float(hdd(ta)), source))
            out.append((fd, td, region, "cdd", float(cdd(ta)), source))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Load backfilled Parquet into the SQLite weather cache.")
    ap.add_argument("--source", default="gefs_reforecast",
                    help="Source subdir under extracted/ (e.g. gefs_reforecast).")
    ap.add_argument("--start", help="Only import issuance dates >= this YYYY-MM-DD")
    ap.add_argument("--end", help="Only import issuance dates <= this YYYY-MM-DD")
    ap.add_argument("--db", default=str(DEFAULT_DB_PATH),
                    help="SQLite DB path (default: the live weather cache).")
    args = ap.parse_args()

    src_dir = gc.extracted_dir(args.source)
    files = sorted(src_dir.glob("*.parquet"))
    if args.start:
        s = datetime.strptime(args.start, "%Y-%m-%d").date()
        files = [f for f in files if datetime.strptime(f.stem, "%Y-%m-%d").date() >= s]
    if args.end:
        e = datetime.strptime(args.end, "%Y-%m-%d").date()
        files = [f for f in files if datetime.strptime(f.stem, "%Y-%m-%d").date() <= e]
    if not files:
        log.warning("no Parquet files in %s for the requested range", src_dir)
        return 0

    db_path = Path(args.db)
    if not db_path.exists():
        log.error("DB not found: %s — start the server once to create it, or "
                  "check the path.", db_path)
        return 1

    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        total_rows = 0
        for i, f in enumerate(files, 1):
            df = pd.read_parquet(f)
            if df.empty:
                continue
            rows = _rows_for(df, args.source)
            conn.execute("BEGIN")
            try:
                conn.executemany(INSERT_SQL, rows)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
            total_rows += len(rows)
            if i % 100 == 0 or i == len(files):
                log.info("imported %d/%d cycles (%d forecast_daily rows so far)",
                         i, len(files), total_rows)
        log.info("done: %d cycles, %d forecast_daily rows into %s",
                 len(files), total_rows, db_path)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
