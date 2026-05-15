"""Open-Meteo Previous Runs API client — TRUE issuance-anchored vintage.

For a past issuance date X, returns the forecast as it actually existed on X:
  - target_date == X      → analysis / short-lead value for X
  - target_date == X + N  → forecast issued ON X at lead N (1..14)

This uses the `previous_dayN` mechanism documented at
https://open-meteo.com/en/docs/previous-runs-api — `temperature_2m_previous_day7`
means "the value as the model was forecasting it 7 days before publication."
For target Y and issuance X with lead N = Y − X, that's exactly the forecast
issued on X for Y, which is what we need.

Coverage (per Open-Meteo docs, verified by probe 2026-05-11):
  - GFS 2m temperature: 2021-03-23 onward
  - Most other models: 2024 onward (not used by us)

Pre-2021-04 dates return no data — see docs/weather-data-spec.md §10 for the
GRIB2 path required to fill that gap (Phase 3).

The endpoint only supports the **hourly** schema for previous_dayN fields, so
we fetch hourly values and aggregate to daily Tmax/Tmin ourselves. We pin the
timezone to America/Chicago (same as the live ingestion) for day-boundary
consistency.
"""
from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger("weather.openmeteo_historical")

BASE_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
USER_AGENT = "trade-chart-weather/0.1"
TIMEOUT_S = 60        # bigger than live — hourly responses are ~15×24=360 hours
MAX_LEAD = 14         # we display horizons up to 14D; lead 0..14 = 15 fields
MODEL = "gfs_seamless"
UNIT = "fahrenheit"
TZ = "America/Chicago"

# Earliest issuance date supported by the Previous Runs API for GFS 2m temp.
# Verified by curl 2026-05-11; the API errors with "out of allowed range" for
# any earlier date. Pre-this requires GRIB2 ETL (spec §10 Phase 3).
GFS_PREVIOUS_RUNS_START = date(2021, 4, 1)


def fetch_vintage_daily(
    lat: float, lon: float, issuance_date: date,
) -> Dict[date, Tuple[float, float]]:
    """Return {target_date: (tmax_f, tmin_f)} as forecast ON issuance_date.

    For each target date Y in [issuance_date, issuance_date + MAX_LEAD]:
      - if Y == issuance_date: uses `temperature_2m` (analysis/short-lead)
      - else: uses `temperature_2m_previous_day{Y - issuance_date}` (issuance-X forecast)

    A target date with no data (e.g. lead beyond what's stored, or stale rows)
    is simply omitted from the return — caller treats missing as "no data"
    and the panel cell renders `—`.

    Raises on network error or unexpected response shape. Returns an empty
    dict (NOT raise) when the API explicitly says the issuance date is out
    of range — that's a structural limit, not a bug.
    """
    if issuance_date < GFS_PREVIOUS_RUNS_START:
        return {}

    end_date = issuance_date + timedelta(days=MAX_LEAD)

    # Hourly fields: current temperature_2m + previous_day1..MAX_LEAD.
    # `temperature_2m` is the analysis at each hour (we use it only for the
    # issuance-date itself, where lead=0). For lead≥1 we look up the matching
    # previous_dayN field for the appropriate target.
    fields = ["temperature_2m"] + [
        f"temperature_2m_previous_day{n}" for n in range(1, MAX_LEAD + 1)
    ]
    params = {
        "latitude": f"{lat}",
        "longitude": f"{lon}",
        "start_date": issuance_date.isoformat(),
        "end_date": end_date.isoformat(),
        "hourly": ",".join(fields),
        "temperature_unit": UNIT,
        "timezone": TZ,
        "models": MODEL,
    }
    url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"

    body = _fetch_with_retry(url)
    if body is None:
        # Out-of-range issuance (400) or persistent failure — return empty
        # rather than raising so the caller's parallel fan-out can continue.
        return {}
    data = json.loads(body)

    if data.get("error"):
        logger.info("Previous Runs API error %s for %s",
                    data.get("reason"), issuance_date)
        return {}

    hourly = data.get("hourly")
    if not hourly or "time" not in hourly:
        raise ValueError(f"Previous Runs response missing 'hourly.time': {data!r}")

    times: List[str] = hourly["time"]

    # Group hourly values by target date, picking the right lead field per row.
    # by_target[target_date] = list of hourly values from the lead-appropriate field
    by_target: Dict[date, List[float]] = {}
    for i, t in enumerate(times):
        try:
            target = datetime.strptime(t[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        lead = (target - issuance_date).days
        if lead < 0 or lead > MAX_LEAD:
            continue
        field = ("temperature_2m" if lead == 0
                 else f"temperature_2m_previous_day{lead}")
        col = hourly.get(field)
        if col is None:
            continue
        v = col[i]
        if v is None:
            continue
        by_target.setdefault(target, []).append(float(v))

    # Daily Tmax/Tmin per target.
    out: Dict[date, Tuple[float, float]] = {}
    for target, vals in by_target.items():
        if not vals:
            continue
        out[target] = (max(vals), min(vals))
    return out


# Open-Meteo's Previous Runs endpoint enforces a tighter per-second rate limit
# than the regular Forecast API. With 8 parallel workers hitting 57 coords, a
# fraction of requests hit 429. We retry with exponential backoff + jitter.
# The total per-coord budget (~30s) is bounded so a degenerate failure mode
# doesn't block ingestion indefinitely — failed coords just become missing
# states in the regional aggregate.
_RETRY_429_SCHEDULE = [1.0, 2.0, 4.0, 8.0]    # seconds; total ~15s ceiling


def _fetch_with_retry(url: str) -> Optional[bytes]:
    """GET `url`, retrying on 429. Returns body bytes or None.

    Returns None (not raises) when:
      - The API responds with 400 + `{"error":true,"reason":"out of range"}`
        — structural limit, caller treats as "no data for this issuance"
      - All retries exhausted on 429 — caller treats as a transient failure

    Other HTTP errors raise — those are bugs we want to see.
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_429 = None
    for attempt, base_sleep in enumerate([0.0] + _RETRY_429_SCHEDULE):
        if base_sleep > 0:
            # Add 0..50% jitter so 57 parallel retriers don't synchronize.
            time.sleep(base_sleep * (1.0 + random.random() * 0.5))
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 400:
                # Out-of-range issuance, etc. Log and downgrade.
                try:
                    err = json.loads(e.read())
                    logger.info("Previous Runs API 400: %s", err.get("reason"))
                except Exception:
                    pass
                return None
            if e.code == 429:
                last_429 = e
                continue
            raise
    logger.warning("Previous Runs API: 429 exhausted retries (%s)", last_429)
    return None
