"""Unit tests for the weather compute layer.

Each test cites the spec section it verifies, so a future reader can audit
the math by reading docs/weather-data-spec.md alongside this file.

Run from project root:
    python -m tests.test_weather
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from server.weather.compute import (  # noqa: E402
    HORIZONS, MIN_BASELINE_N, aggregate_region, build_region_panel, cdd, hdd,
    modified_z, n_day_min, n_day_sum, revision_n_day_sum, tavg,
)


# ---- Test harness (matches existing test_ranks.py pattern) ------------------

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


def near(a, b, tol=1e-6):
    if a is None or b is None:
        return a is b
    return abs(a - b) <= tol


# ---- Spec §4.1: HDD/CDD per day --------------------------------------------

def test_hdd_cdd_basic():
    print("hdd / cdd (spec §4.1):")
    # 50°F day -> HDD=15, CDD=0
    check("HDD at 50°F = 15", near(hdd(50.0), 15.0))
    check("CDD at 50°F = 0",  near(cdd(50.0), 0.0))
    # 75°F day -> HDD=0, CDD=10
    check("HDD at 75°F = 0",  near(hdd(75.0), 0.0))
    check("CDD at 75°F = 10", near(cdd(75.0), 10.0))
    # Base-temperature day: 65°F -> both zero (the neutral point)
    check("HDD at 65°F = 0", near(hdd(65.0), 0.0))
    check("CDD at 65°F = 0", near(cdd(65.0), 0.0))
    # Definitional: HDD and CDD are mutually exclusive on a single day
    for t in (10.0, 32.0, 64.99, 65.01, 80.0, 105.0):
        check(f"HDD*CDD == 0 @ {t}°F", hdd(t) * cdd(t) == 0)


def test_tavg():
    print("tavg (spec §4.1):")
    check("(20+50)/2 = 35", near(tavg(50, 20), 35.0))
    check("symmetric", near(tavg(80, 60), tavg(60, 80)))


# ---- Spec §4.3: Region aggregation -----------------------------------------

def test_aggregate_region_pop_weighted():
    print("aggregate_region (spec §4.3):")
    # WSC has 4 states (AR, LA, OK, TX). TX is by far the largest pop, so its
    # value should dominate. Construct an extreme test: TX=100, others=0 ->
    # weighted average should be ~TX_pop / total_pop * 100, which is well over 50.
    sv = {"AR": 0.0, "LA": 0.0, "OK": 0.0, "TX": 100.0}
    agg = aggregate_region("WSC", sv)
    check("WSC dominated by TX (TX=100, others=0)",
          agg is not None and agg > 70.0,
          f"got {agg}")

    # Symmetric uniform values should yield exactly that value.
    sv = {"AR": 50.0, "LA": 50.0, "OK": 50.0, "TX": 50.0}
    check("uniform 50 -> 50", near(aggregate_region("WSC", sv), 50.0))

    # Empty input -> None (spec semantics: never silently zero).
    check("empty input -> None", aggregate_region("WSC", {}) is None)

    # Unknown region -> raises.
    raised = False
    try:
        aggregate_region("nope", {"TX": 1.0})
    except ValueError:
        raised = True
    check("unknown region raises", raised)


def test_aggregate_region_partial_states():
    print("aggregate_region with partial states:")
    # Only TX present in WSC; should equal TX's value (not weighted into 0s).
    agg = aggregate_region("WSC", {"TX": 42.0})
    check("WSC with only TX -> 42", near(agg, 42.0))


# ---- Spec §4.4: N-day sums -------------------------------------------------

def test_n_day_sum_basic():
    print("n_day_sum (spec §4.4):")
    base = date(2026, 1, 15)
    daily = {base + timedelta(days=i): float(i + 1) for i in range(7)}
    # n=1 -> daily[base] = 1.0
    check("n=1 sum from base = 1", near(n_day_sum(daily, base, 1), 1.0))
    # n=3 sum from base = 1+2+3 = 6
    check("n=3 sum = 6", near(n_day_sum(daily, base, 3), 6.0))
    # n=7 sum = 1+2+3+4+5+6+7 = 28
    check("n=7 sum = 28", near(n_day_sum(daily, base, 7), 28.0))
    # Missing data anywhere in window -> None
    daily_missing = dict(daily)
    del daily_missing[base + timedelta(days=2)]
    check("missing day -> None", n_day_sum(daily_missing, base, 5) is None)


def test_n_day_min_basic():
    print("n_day_min (spec §4.7):")
    base = date(2026, 1, 15)
    daily = {base + timedelta(days=i): float(20 + i * 3) for i in range(5)}
    # Values: 20, 23, 26, 29, 32. Min over 5 = 20.
    check("min over 5 days = 20", near(n_day_min(daily, base, 5), 20.0))
    # Missing data -> None (same rule as n_day_sum).
    daily2 = dict(daily); del daily2[base + timedelta(days=2)]
    check("missing day -> None", n_day_min(daily2, base, 5) is None)


# ---- Spec §4.5: Apples-to-apples revision ----------------------------------

def test_revision_apples_to_apples():
    print("revision_n_day_sum (spec §4.5):")
    # Today (forecast_date=t) sees: target day t+1=10, t+2=12, t+3=14
    today_view = {date(2026, 1, 16): 10.0, date(2026, 1, 17): 12.0,
                  date(2026, 1, 18): 14.0}
    # Yesterday (forecast_date=t-1) saw the SAME target days as: 8, 11, 15
    yesterday_view = {date(2026, 1, 16): 8.0, date(2026, 1, 17): 11.0,
                      date(2026, 1, 18): 15.0}
    # 3-day target window starting t+1 = forecast_date+1 = 2026-01-16
    # today: 10+12+14=36; yesterday: 8+11+15=34; revision = +2
    rev = revision_n_day_sum(today_view, yesterday_view, date(2026, 1, 16), 3)
    check("3-day revision = +2", near(rev, 2.0))

    # Apples-to-apples invariant: if today and yesterday have IDENTICAL target
    # values, revision must be exactly 0 — even though their issuance dates
    # differ. This is the whole point of the apples-to-apples logic.
    rev0 = revision_n_day_sum(today_view, today_view, date(2026, 1, 16), 3)
    check("identical views -> revision 0", near(rev0, 0.0))

    # Missing data on either side -> None (no spurious partial revision).
    incomplete = {date(2026, 1, 16): 10.0}  # only 1 of 3 days
    rev_n = revision_n_day_sum(incomplete, yesterday_view, date(2026, 1, 16), 3)
    check("incomplete today -> None", rev_n is None)
    rev_n = revision_n_day_sum(today_view, incomplete, date(2026, 1, 16), 3)
    check("incomplete yesterday -> None", rev_n is None)


# ---- Spec §4.6: Modified Z-score -------------------------------------------

def test_modified_z_basic():
    print("modified_z (spec §4.6):")
    # Insufficient baseline -> None (gating per MIN_BASELINE_N).
    check(f"baseline < {MIN_BASELINE_N} -> None",
          modified_z(0.0, [1.0] * (MIN_BASELINE_N - 1)) is None)

    # Constant baseline -> MAD=0 -> None (degenerate).
    constant = [5.0] * 50
    check("MAD=0 -> None", modified_z(99.0, constant) is None)

    # Symmetric baseline around 0: median=0, MAD=median(|x_i|).
    # Construct: [-3,-2,-1,1,2,3] repeated until length 60.
    base = [-3.0, -2.0, -1.0, 1.0, 2.0, 3.0] * 10
    # median = 0. MAD = median([3,2,1,1,2,3]*10) = median sorted [1,1,1...3,3,3] = 2
    # Z(value=0) = 0.6745 * (0 - 0) / 2 = 0
    check("centered value -> Z=0", near(modified_z(0.0, base), 0.0))
    # Z(value=4) = 0.6745 * 4 / 2 = 1.349
    check("Z(4) = 1.349", near(modified_z(4.0, base), 1.349, tol=0.01))


def test_modified_z_outlier_robustness():
    print("modified_z robustness vs outliers:")
    # One huge outlier should NOT change Z(value) — that's the whole point of
    # median absolute deviation instead of stddev. Construct a baseline where
    # the central five values are 0 (so the median is firmly 0 and stays 0
    # when we add an outlier — no median-shift confound), with symmetric
    # mass at ±1 and ±2 so MAD = 1 cleanly.
    normal = [-2.0] * 9 + [-1.0] * 9 + [0.0] * 5 + [1.0] * 9 + [2.0] * 9  # n=41
    z_no_outlier = modified_z(2.0, normal)
    polluted = normal + [1000.0]                                          # n=42
    z_with_outlier = modified_z(2.0, polluted)
    # Both should give Z(2) = 0.6745 * 2 / 1 = 1.349 — the outlier neither
    # shifts the median nor the MAD.
    check("Z without outlier = 1.349", near(z_no_outlier, 1.349, tol=0.01))
    check("Z with outlier still ~1.349 (MAD robust)",
          near(z_with_outlier, 1.349, tol=0.01),
          f"got {z_with_outlier}")
    # Compare to a parametric (mean+stddev) Z for the same setup, where the
    # outlier WOULD blow up the denominator. We don't compute that here —
    # just establishing that MAD-based Z is provably indifferent.


# ---- Integration: build_region_panel ---------------------------------------

def test_build_region_panel_horizon_convention():
    """Verify spec §4.4 horizon convention: Now=today; ND for N>1 is days
    forecast_date+1 through forecast_date+N (NWS Day-1-through-N convention)."""
    print("build_region_panel horizon convention (spec §4.4):")
    fd = date(2026, 1, 15)
    # Construct constant per-state HDD = 10 for all states/days, CDD = 0.
    state_hdd = {}
    state_cdd = {}
    for s in ["TX", "LA", "OK", "AR", "NY", "PA", "IL", "MI"]:  # subset is fine
        state_hdd[s] = {fd + timedelta(days=i): 10.0 for i in range(15)}
        state_cdd[s] = {fd + timedelta(days=i): 0.0 for i in range(15)}

    panel = build_region_panel(fd, state_hdd, state_cdd)
    # WSC region -> Now: 1 day of 10 = 10; 3D: 3 days of 10 = 30; 7D: 70; 14D: 140
    wsc = panel["WSC"]
    check("WSC Now = 10",  near(wsc["Now"]["hdd"], 10.0))
    check("WSC 3D = 30",   near(wsc["3D"]["hdd"], 30.0))
    check("WSC 5D = 50",   near(wsc["5D"]["hdd"], 50.0))
    check("WSC 7D = 70",   near(wsc["7D"]["hdd"], 70.0))
    check("WSC 10D = 100", near(wsc["10D"]["hdd"], 100.0))
    check("WSC 14D = 140", near(wsc["14D"]["hdd"], 140.0))
    # CDD all zero
    check("WSC Now CDD = 0", near(wsc["Now"]["cdd"], 0.0))
    check("WSC 7D CDD = 0",  near(wsc["7D"]["cdd"], 0.0))


def test_build_region_panel_partial_horizons():
    """If we only have 8 days of forecast, 14D should be None but 7D should
    still resolve. Verifies horizon graceful-degradation."""
    print("build_region_panel partial horizons:")
    fd = date(2026, 1, 15)
    state_hdd = {}
    state_cdd = {}
    for s in ["TX", "LA", "OK", "AR"]:
        state_hdd[s] = {fd + timedelta(days=i): 10.0 for i in range(8)}
        state_cdd[s] = {fd + timedelta(days=i): 0.0 for i in range(8)}
    panel = build_region_panel(fd, state_hdd, state_cdd)
    wsc = panel["WSC"]
    # Now (1d of [fd]) + 7D (window [fd+1..fd+7]) both fit: Now=10, 7D=70.
    check("Now resolves with 8 days available", near(wsc["Now"]["hdd"], 10.0))
    check("7D resolves with 8 days available", near(wsc["7D"]["hdd"], 70.0))
    # 14D needs days [fd+1..fd+14] = 14 days from tomorrow; only 7 available.
    check("14D None when insufficient data", wsc["14D"]["hdd"] is None)


# ---- Spec §2: regions sanity ----------------------------------------------

def test_regions_coverage():
    print("regions coverage (spec §2):")
    from server.weather.regions import (
        NATIONAL_STATES, NE_STATES, MW_STATES, WSC_STATES,
        STATE_COORDS, STATE_POP_2023, BASIN_COORDS,
    )
    # Every state has both a coord and a population.
    for s in NATIONAL_STATES:
        check(f"  state {s} has coord", s in STATE_COORDS)
        check(f"  state {s} has pop",   s in STATE_POP_2023 and STATE_POP_2023[s] > 0)
    # National contains exactly NE + MW + WSC + Other (no overlap, no gaps).
    in_three = set(NE_STATES) | set(MW_STATES) | set(WSC_STATES)
    check("NE/MW/WSC pairwise disjoint",
          len(NE_STATES) + len(MW_STATES) + len(WSC_STATES) == len(in_three))
    check("National superset of NE+MW+WSC", in_three.issubset(set(NATIONAL_STATES)))
    # 48 contiguous states - validate count is sensible (NE=9, MW=12, WSC=4,
    # other=23 -> total 48).
    check(f"NATIONAL_STATES count = 48 (got {len(NATIONAL_STATES)})",
          len(NATIONAL_STATES) == 48)
    # Each basin has exactly 3 points.
    for basin, pts in BASIN_COORDS.items():
        check(f"basin {basin} has 3 points", len(pts) == 3)


# ---- Main ------------------------------------------------------------------

def main():
    test_hdd_cdd_basic()
    test_tavg()
    test_aggregate_region_pop_weighted()
    test_aggregate_region_partial_states()
    test_n_day_sum_basic()
    test_n_day_min_basic()
    test_revision_apples_to_apples()
    test_modified_z_basic()
    test_modified_z_outlier_robustness()
    test_build_region_panel_horizon_convention()
    test_build_region_panel_partial_horizons()
    test_regions_coverage()
    print()
    print(f"  {PASSED} passed, {FAILED} failed")
    sys.exit(0 if FAILED == 0 else 1)


if __name__ == "__main__":
    main()
