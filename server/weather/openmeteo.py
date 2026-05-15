"""Open-Meteo Forecast API client.

Spec §3 source A. Fetches daily Tmax/Tmin for a (lat, lon) and returns it as
a {date: (tmax, tmin)} dict. Stays narrow on purpose — the calling layer
(service.py) handles per-state and per-basin orchestration.

We pass `forecast_days=15` to cover today + the next 14 forward days, since
the 14D horizon spans [forecast_date+1, forecast_date+14] (spec §4.4) and we
also need today's value for the "Now" cell.

Open-Meteo is free, no auth, ~10K req/day non-commercial. A full daily refresh
hits ~57 coords (48 states + 9 basin points) — well under limit.
"""
from __future__ import annotations

import json
import logging
import urllib.parse
import urllib.request
from datetime import date, datetime
from typing import Dict, Tuple

logger = logging.getLogger("weather.openmeteo")

BASE_URL = "https://api.open-meteo.com/v1/forecast"
USER_AGENT = "trade-chart-weather/0.1"
TIMEOUT_S = 30

# Open-Meteo's `temperature_unit=fahrenheit` returns Tmax/Tmin in °F directly,
# so we don't need to convert. The spec §3 source A locks this in — change
# this and the spec must change too.
UNIT = "fahrenheit"

# We pin to America/Chicago because (a) HDD/CDD is a daily aggregate and the
# day boundary needs to be a single fixed timezone for reproducibility, and
# (b) Central Time covers the WSC region (TX/LA/OK/AR) which is the most
# gas-relevant zone. Eastern states get aggregated on a slightly-shifted
# day boundary (1 hour off) — acceptable for daily aggregates and avoids
# the much larger problem of state-by-state TZ math.
TZ = "America/Chicago"


def fetch_daily_temps(lat: float, lon: float,
                      forecast_days: int = 15
                      ) -> Dict[date, Tuple[float, float]]:
    """Fetch daily Tmax/Tmin for (lat, lon).

    Returns {date: (tmax_f, tmin_f)} for `forecast_days` days starting today.
    Open-Meteo's day 1 is today (the issuance date), so forecast_days=15
    covers today through today+14 — enough for the 14D forward horizon.

    Raises on network error or unexpected response shape. Caller decides
    whether to swallow and continue (one bad state shouldn't kill the whole
    region aggregate).
    """
    params = {
        "latitude": f"{lat}",
        "longitude": f"{lon}",
        "daily": "temperature_2m_max,temperature_2m_min",
        "forecast_days": str(forecast_days),
        "temperature_unit": UNIT,
        "timezone": TZ,
    }
    url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        body = resp.read()
    data = json.loads(body)

    daily = data.get("daily")
    if not daily:
        raise ValueError(f"Open-Meteo response missing 'daily': {data!r}")

    times = daily.get("time", [])
    tmaxs = daily.get("temperature_2m_max", [])
    tmins = daily.get("temperature_2m_min", [])
    if not (len(times) == len(tmaxs) == len(tmins)):
        raise ValueError(
            f"Open-Meteo daily arrays mismatched: "
            f"time={len(times)} tmax={len(tmaxs)} tmin={len(tmins)}"
        )

    out: Dict[date, Tuple[float, float]] = {}
    for t, hi, lo in zip(times, tmaxs, tmins):
        # Open-Meteo can return null for any day if the model is missing
        # data; skip those rather than crash. Downstream uses .get() so a
        # missing day naturally propagates as "no data" all the way to the
        # panel — which renders as "—".
        if hi is None or lo is None:
            continue
        d = datetime.strptime(t, "%Y-%m-%d").date()
        out[d] = (float(hi), float(lo))
    return out
