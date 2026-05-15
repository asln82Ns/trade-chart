"""NOAA AO (Arctic Oscillation) index — current observations + GFS forecast.

Spec §3 sources C and D. Two files:
  - Daily observed AO since 1950-01-01 (one ASCII file, refetched in entirety
    each refresh — it's only ~490KB)
  - 120-day GFS-derived AO forecast (CSV)

We use AO as a strongly-correlated proxy for stratospheric polar vortex
strength. Negative AO = weakened/disrupted vortex (cold air dumps south);
positive AO = strong vortex (cold locked in the Arctic).
"""
from __future__ import annotations

import csv
import io
import logging
import urllib.request
from datetime import date
from typing import Dict, List, Tuple

logger = logging.getLogger("weather.ao")

OBSERVED_URL = (
    "https://ftp.cpc.ncep.noaa.gov/cwlinks/"
    "norm.daily.ao.index.b500101.current.ascii"
)
FORECAST_URL = (
    "https://ftp.cpc.ncep.noaa.gov/cwlinks/"
    "norm.daily.ao.gfs.z1000.120days.csv"
)

USER_AGENT = "trade-chart-weather/0.1"
TIMEOUT_S = 60   # longer than openmeteo — these are larger files


def fetch_observed_ao() -> Dict[date, float]:
    """Daily observed AO from 1950-01-01 to current. Returns {date: value}.

    File format (whitespace-separated):
        YYYY  M  D    value

    Each daily value is normalized by the standard deviation of the monthly
    AO index from 1979-2000 (per NOAA CPC documentation).
    """
    req = urllib.request.Request(OBSERVED_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        text = resp.read().decode("ascii")

    out: Dict[date, float] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
            v = float(parts[3])
        except ValueError:
            # Header or garbage line — skip silently. The file format is
            # consistent enough that bad lines are very rare in practice.
            continue
        out[date(y, m, d)] = v
    return out


def fetch_forecast_ao() -> Dict[date, Dict[date, float]]:
    """GFS-based AO forecasts. Returns {issuance_date: {target_date: value}}.

    File format (CSV, header row + data):
        lead, time, ao_index, valid_time

    Where:
        time       = the issuance date (when the forecast was made)
        lead       = days ahead from issuance (0 = analysis, 1..15 = forecast)
        valid_time = the date being forecasted (= time + lead days)
        ao_index   = AO value
    The file actually contains ~120 vintages — one per `time` date — each with
    0..15-day lead forecasts. We extract every vintage so `service.py` can
    backfill day-over-day revision history from this single fetch.
    """
    req = urllib.request.Request(FORECAST_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        text = resp.read().decode("ascii", errors="replace")

    reader = csv.DictReader(io.StringIO(text))
    out: Dict[date, Dict[date, float]] = {}
    for row in reader:
        try:
            issued = _parse_ao_date(row["time"])
            valid = _parse_ao_date(row["valid_time"])
            v = float(row["ao_index"])
        except (KeyError, ValueError, TypeError):
            continue
        out.setdefault(issued, {})[valid] = v

    if not out:
        raise ValueError("AO forecast file parsed empty (check column names)")
    return out


def _parse_ao_date(s: str) -> date:
    """NOAA AO date columns are sometimes `YYYY-MM-DD`, sometimes `YYYYMMDD`,
    sometimes `M/D/YYYY`. Try the common ones."""
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y", "%-m/%-d/%Y"):
        try:
            from datetime import datetime as _dt
            return _dt.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unparseable AO date: {s!r}")
