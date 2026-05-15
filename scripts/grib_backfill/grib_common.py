"""Shared helpers for the one-time GRIB backfill.

The backfill scripts live in scripts/grib_backfill/ but reuse the live app's
region/coordinate definitions (server.weather.regions) so the backfilled data
uses the EXACT same 57 grid points the Open-Meteo path uses. That's the whole
point — replay panels for 2010-2019 should be methodologically identical to
2021+ panels, just sourced from a different archive.

Nothing here is imported by the runtime server. See README.md.
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple
from zoneinfo import ZoneInfo

# Make `server.weather.*` importable from these scripts (same trick as
# tests/test_ranks.py). scripts/grib_backfill/ -> ../../ is the project root.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from server.weather.regions import (  # noqa: E402
    BASIN_COORDS, NATIONAL_STATES, STATE_COORDS,
)

# ---------------------------------------------------------------------------
# The 57 sample points: 48 state coords + 9 basin points (3 per basin).
# coord_label matches the `region` column convention used by the live
# Open-Meteo ingestion (server/weather/service.py:_parallel_ingest):
#   "state:XX"            for the 48 contiguous states
#   "basin:NAME:i"        for basin point i (0..2) of basin NAME
# ---------------------------------------------------------------------------

def sample_points() -> List[Tuple[str, float, float]]:
    """Return [(coord_label, lat, lon), ...] for all 57 points.

    Longitudes are kept in the project's native -180..180 convention here;
    callers that hit a 0..360 grid (GEFS, GFS) must wrap with `lon % 360`.
    """
    pts: List[Tuple[str, float, float]] = []
    for s in NATIONAL_STATES:
        lat, lon = STATE_COORDS[s]
        pts.append((f"state:{s}", lat, lon))
    for basin, points in BASIN_COORDS.items():
        for i, (lat, lon) in enumerate(points):
            pts.append((f"basin:{basin}:{i}", lat, lon))
    return pts


# ---------------------------------------------------------------------------
# Unit + timezone helpers.
# ---------------------------------------------------------------------------

# HDD/CDD and the live Open-Meteo path are anchored to America/Chicago calendar
# days (server/weather/openmeteo.py TZ). Backfilled data MUST use the same day
# boundary or the two eras won't be comparable.
CENTRAL = ZoneInfo("America/Chicago")

# 0 °C = 273.15 K; °F = °C * 9/5 + 32  ==>  °F = K * 9/5 - 459.67
def kelvin_to_fahrenheit(k: float) -> float:
    return k * 9.0 / 5.0 - 459.67


def utc_to_central_date(dt_utc: datetime) -> date:
    """Calendar date in America/Chicago for a UTC instant.

    GRIB valid_times are UTC. We bucket each forecast timestep into the
    Central-time day it falls in, then take per-day Tmax/Tmin from the
    timesteps in that bucket — matching how Open-Meteo's hourly→daily
    aggregation works for `timezone=America/Chicago`.
    """
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=timezone.utc)
    return dt_utc.astimezone(CENTRAL).date()


# ---------------------------------------------------------------------------
# Extracted-Parquet layout (Phase B output, Phase C input).
# One file per (source, issuance_date): extracted/<source>/<YYYY-MM-DD>.parquet
# Columns: forecast_date | target_date | coord_label | tmax_f | tmin_f
# A target_date is only written if the Central day had enough timesteps to be
# a reasonable daily extreme (see MIN_SAMPLES_PER_DAY).
# ---------------------------------------------------------------------------

MIN_SAMPLES_PER_DAY = 5  # of 8 expected 3-hourly samples; partial edge days dropped

PARQUET_COLUMNS = ["forecast_date", "target_date", "coord_label", "tmax_f", "tmin_f"]


def extracted_dir(source: str) -> Path:
    d = Path(__file__).resolve().parent / "extracted" / source
    d.mkdir(parents=True, exist_ok=True)
    return d


def extracted_path(source: str, issuance_date: date) -> Path:
    return extracted_dir(source) / f"{issuance_date.isoformat()}.parquet"
