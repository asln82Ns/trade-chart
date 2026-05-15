"""GEFS Reforecast v12 source — AWS Open Data bucket `noaa-gefs-retrospective`.

Coverage: 2000-2019, 5-member ensemble (c00 control + p01..p04 perturbed),
once-daily 00Z init. We use it to backfill 2010-2019 (the era before
Open-Meteo Previous Runs coverage begins, 2021-04).

File layout (verified 2026-05-12):
  GEFSv12/reforecast/{YYYY}/{YYYYMMDD00}/{member}/Days:1-10/tmp_2m_{YYYYMMDD00}_{member}.grib2
  - one file per (cycle, member), ~60 MB
  - contains 2m temperature `t2m` (Kelvin) on a 0.25° global grid
    (lat -90..90 / 721 pts, lon 0..359.75 / 1440 pts)
  - 80 timesteps, 3-hourly, +3h .. +240h (Days:1-10)
  There's also a Days:10-16 chunk (+240h..+384h) we DON'T fetch yet — that's
  what would populate the 10D/14D panel cells for pre-2020 dates. Adding it is
  one more file per member; deferred to keep the download volume ~halved.

Daily aggregation: each timestep's valid_time is bucketed into its
America/Chicago calendar day; Tmax/Tmin per day come from the timesteps in
that bucket (ensemble-mean temperature first, then daily extremes).
"""
from __future__ import annotations

from datetime import date
from typing import List

S3_BASE = "https://noaa-gefs-retrospective.s3.amazonaws.com"

# Member selection. `backfill.py --members control` (the DEFAULT) uses only
# c00 — 1 file per cycle, ~1/5 the download (~220 GB vs ~1.1 TB for 2010-2019),
# which fits an overnight run. c00 is the unperturbed control run — a perfectly
# valid forecast; the day-over-day signal we care about is barely different
# from the ensemble mean at the 0-7 day leads we use. `--members all` (or
# BACKFILL_MEMBERS=all) averages all 5 members for the smoother ensemble-mean
# forecast, at ~5x the download.
ALL_MEMBERS = ["c00", "p01", "p02", "p03", "p04"]
CONTROL_ONLY = ["c00"]

# GEFS Reforecast v12 retrospective span.
COVERAGE_START = date(2000, 1, 1)
COVERAGE_END = date(2019, 12, 31)

VARIABLE = "tmp_2m"     # 2 m temperature, instantaneous
CHUNK = "Days:1-10"      # +3h .. +240h


def cycle_str(issuance_date: date) -> str:
    """GEFS cycle id is YYYYMMDD + '00' (all reforecast inits are 00Z)."""
    return issuance_date.strftime("%Y%m%d") + "00"


def grib_url(issuance_date: date, member: str) -> str:
    cyc = cycle_str(issuance_date)
    yyyy = issuance_date.strftime("%Y")
    return (f"{S3_BASE}/GEFSv12/reforecast/{yyyy}/{cyc}/{member}/{CHUNK}/"
            f"{VARIABLE}_{cyc}_{member}.grib2")


def members_for(mode: str) -> List[str]:
    return CONTROL_ONLY if mode == "control" else ALL_MEMBERS


def in_coverage(issuance_date: date) -> bool:
    return COVERAGE_START <= issuance_date <= COVERAGE_END
