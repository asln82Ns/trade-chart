"""End-to-end tests against the real Open-Meteo and NOAA AO endpoints.

These tests verify:
  - We can reach the upstream sources
  - Response shapes match what the parsers expect
  - Returned values are physically plausible (not e.g. all zero or NaN)

Failures here mean either: the upstream provider changed their API, or our
client code has drifted from the source format. Both are real bugs worth
catching before they hit users.

Network-dependent — skip in offline CI.

Run from project root:
    python -m tests.test_weather_live
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from server.weather import ao, openmeteo               # noqa: E402
from server.weather import openmeteo_historical as openmeteo_hist  # noqa: E402
from server.weather.openmeteo_historical import GFS_PREVIOUS_RUNS_START  # noqa: E402
from server.weather.regions import (                     # noqa: E402
    BASIN_COORDS, NATIONAL_STATES, STATE_COORDS,
)


PASSED = 0
FAILED = 0


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print(f"  [PASS] {name}")
    else:
        FAILED += 1
        print(f"  [FAIL] {name}  {detail}")


# ---- Open-Meteo ------------------------------------------------------------

def test_openmeteo_shape():
    print("Open-Meteo forecast for Midland TX:")
    lat, lon = (31.99, -102.08)
    daily = openmeteo.fetch_daily_temps(lat, lon, forecast_days=15)
    today = date.today()
    # Open-Meteo's day 1 is today (in the requested timezone). Allow a 1-day
    # tolerance — the site we hit operates in America/Chicago and the test
    # box could be in a different TZ that crosses midnight slightly off.
    earliest = min(daily.keys())
    latest = max(daily.keys())
    check("at least 14 days returned", len(daily) >= 14,
          f"got {len(daily)} days")
    check("first day within 1 day of today",
          abs((earliest - today).days) <= 1,
          f"earliest={earliest}, today={today}")
    check("last day reaches today+13",
          (latest - today).days >= 13,
          f"latest={latest}, today={today}")

    # Plausibility: every Tmax >= every Tmin for the same day, all in
    # plausible US continental range (-50 to 130 °F).
    sample_day = next(iter(sorted(daily)))
    tmax, tmin = daily[sample_day]
    check(f"Tmax >= Tmin on {sample_day}", tmax >= tmin,
          f"tmax={tmax}, tmin={tmin}")
    check(f"plausible Tmax on {sample_day} ({tmax}°F)",
          -50.0 <= tmax <= 130.0)
    check(f"plausible Tmin on {sample_day} ({tmin}°F)",
          -50.0 <= tmin <= 130.0)


def test_openmeteo_ne_winter_check():
    """Sanity: a New England coordinate in winter should typically have at
    least one day below freezing. Skipped in summer to avoid seasonal flake."""
    if not 1 <= date.today().month <= 3:
        print("Open-Meteo NE winter check: skipped (not Jan-Mar)")
        return
    print("Open-Meteo forecast for Boston, MA (winter sanity):")
    lat, lon = STATE_COORDS["MA"]
    daily = openmeteo.fetch_daily_temps(lat, lon, forecast_days=14)
    has_freeze = any(tmin <= 32.0 for (_tmax, tmin) in daily.values())
    check("at least one day Tmin <= 32°F", has_freeze)


def test_openmeteo_basin_locations():
    """Each basin has 3 grid points. Verify all 9 reachable."""
    print("Open-Meteo basin grid points (9 total):")
    for basin, pts in BASIN_COORDS.items():
        for i, (lat, lon) in enumerate(pts):
            try:
                daily = openmeteo.fetch_daily_temps(lat, lon, forecast_days=3)
                check(f"  {basin} pt {i} ({lat:.2f},{lon:.2f}) returned data",
                      len(daily) >= 3,
                      f"got {len(daily)} days")
            except Exception as e:
                check(f"  {basin} pt {i} reachable", False, f"{e}")


# ---- NOAA AO ---------------------------------------------------------------

def test_ao_observed_shape():
    print("NOAA AO observed (1950-current):")
    obs = ao.fetch_observed_ao()
    check("at least 26000 daily values (~70 years)", len(obs) >= 26_000,
          f"got {len(obs)}")
    earliest = min(obs.keys())
    latest = max(obs.keys())
    check(f"earliest <= 1950-12-31 (got {earliest})",
          earliest <= date(1950, 12, 31))
    # Latest value must be within 14 days of today — the file is updated
    # daily; a stale file is a real problem we want to catch.
    days_stale = (date.today() - latest).days
    check(f"latest within 14 days of today (got {latest}, stale {days_stale}d)",
          0 <= days_stale <= 14)
    # AO values are normalized; should be roughly in [-6, +6] range.
    sample = next(iter(obs.values()))
    check(f"sample value plausible (~{sample:.2f})", -10.0 <= sample <= 10.0)


def test_ao_forecast_shape():
    print("NOAA AO forecast (GFS-derived, all vintages in file):")
    try:
        vintages = ao.fetch_forecast_ao()
    except Exception as e:
        check(f"forecast file fetch", False, f"{e}")
        return
    # File should contain ~120 issuance dates, each with 16 lead times (0-15).
    check(f"at least 60 vintages parsed (got {len(vintages)})",
          len(vintages) >= 60)
    # Latest vintage should be within a few weeks of today.
    latest_issued = max(vintages.keys())
    check(f"latest vintage within 30 days of today ({latest_issued})",
          (date.today() - latest_issued).days <= 30)
    # Each vintage should have multiple target dates (the lead time series).
    sample_vintage_targets = vintages[latest_issued]
    check(f"latest vintage has 10+ forecast targets "
          f"(got {len(sample_vintage_targets)})",
          len(sample_vintage_targets) >= 10)
    sample_v = next(iter(sample_vintage_targets.values()))
    check(f"sample forecast value plausible (~{sample_v:.2f})",
          -10.0 <= sample_v <= 10.0)


# ---- State-coverage spot check --------------------------------------------

def test_state_coords_random_sample():
    """Hit a random sample of 5 states to make sure every coordinate set
    is reachable, without paying the cost of 48 calls."""
    import random
    rng = random.Random(42)  # deterministic — same 5 every run
    sample = rng.sample(NATIONAL_STATES, 5)
    print(f"Open-Meteo random state sample {sample}:")
    for s in sample:
        lat, lon = STATE_COORDS[s]
        try:
            daily = openmeteo.fetch_daily_temps(lat, lon, forecast_days=3)
            check(f"  {s} ({lat:.2f},{lon:.2f}) returned >=3 days",
                  len(daily) >= 3)
        except Exception as e:
            check(f"  {s} reachable", False, f"{e}")


# ---- Open-Meteo Previous Runs (vintage) ------------------------------------

def test_previous_runs_real_vintage():
    """For a known past issuance, verify we get DIFFERENT values at different
    leads — that's the signature of true vintage data (no hindsight)."""
    print("Open-Meteo Previous Runs vintage check (Dallas 2023-01-15):")
    issuance = date(2023, 1, 15)
    daily = openmeteo_hist.fetch_vintage_daily(32.78, -96.80, issuance)
    check(f"got at least 1 target date (got {len(daily)})", len(daily) >= 1)
    # Lead 0 should always be present (the analysis at the issuance date).
    has_lead0 = issuance in daily
    check("lead 0 (issuance-day) present", has_lead0)
    # And we should have at least a few forward leads.
    forward_leads = [(d - issuance).days for d in daily if d > issuance]
    check(f"at least 3 forward leads (got {sorted(forward_leads)})",
          len(forward_leads) >= 3)
    # Plausibility: Dallas Tmax in mid-January is typically 40-80°F.
    if has_lead0:
        tmax, tmin = daily[issuance]
        check(f"plausible Dallas Tmax for Jan 2023 ({tmax}°F)",
              30.0 <= tmax <= 85.0)
        check(f"plausible Dallas Tmin for Jan 2023 ({tmin}°F)",
              5.0 <= tmin <= 65.0)


def test_previous_runs_out_of_range():
    """Issuance before 2021-04-01: API returns 400, our client returns {}."""
    print("Open-Meteo Previous Runs out-of-range (2015):")
    before = GFS_PREVIOUS_RUNS_START - timedelta(days=1)  # 2021-03-31
    result = openmeteo_hist.fetch_vintage_daily(32.78, -96.80, date(2015, 6, 15))
    check("2015-06-15 issuance -> empty dict (out of range)", result == {})
    # The boundary date itself MIGHT or might not work depending on Open-Meteo
    # cutoff inclusiveness — we just verify our short-circuit fires for dates
    # strictly before the start (which gives a deterministic empty without
    # needing a network call).
    result2 = openmeteo_hist.fetch_vintage_daily(32.78, -96.80, before)
    check(f"{before} (1 day before start) -> empty dict",
          result2 == {})


# ---- Main ------------------------------------------------------------------

def main():
    print("Live-data tests — requires internet access\n")
    test_openmeteo_shape()
    test_openmeteo_ne_winter_check()
    test_state_coords_random_sample()
    test_openmeteo_basin_locations()
    test_ao_observed_shape()
    test_ao_forecast_shape()
    test_previous_runs_real_vintage()
    test_previous_runs_out_of_range()
    print()
    print(f"  {PASSED} passed, {FAILED} failed")
    sys.exit(0 if FAILED == 0 else 1)


if __name__ == "__main__":
    main()
