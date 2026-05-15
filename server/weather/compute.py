"""Pure-math layer: HDD/CDD, N-day sums, day-over-day revisions, modified Z.

Every formula here corresponds to a numbered section in
docs/weather-data-spec.md. Section refs are inline in the docstrings so
auditing the math is one click away.

This module has NO I/O. It takes plain dicts/lists and returns plain
dicts/lists. Easy to unit-test without mocking.
"""
from __future__ import annotations

from datetime import date, timedelta
from statistics import median as _median
from typing import Dict, Iterable, Mapping, Optional, Sequence

from .regions import REGIONS, state_weight


# ---------------------------------------------------------------------------
# Section 4.1: HDD / CDD per day
# ---------------------------------------------------------------------------

BASE_F = 65.0


def hdd(tavg_f: float) -> float:
    """Heating degree days for one day. Spec §4.1."""
    return max(0.0, BASE_F - tavg_f)


def cdd(tavg_f: float) -> float:
    """Cooling degree days for one day. Spec §4.1."""
    return max(0.0, tavg_f - BASE_F)


def tavg(tmax_f: float, tmin_f: float) -> float:
    """Daily mean = (Tmax + Tmin) / 2. Spec §4.1."""
    return (tmax_f + tmin_f) / 2.0


# ---------------------------------------------------------------------------
# Section 4.3: Region aggregation (population-weighted state mean)
# ---------------------------------------------------------------------------

def aggregate_region(
    region: str,
    state_values: Mapping[str, float],
) -> Optional[float]:
    """Population-weighted average of state values for one region.

    Returns None if no states for this region have data (caller decides how
    to render). Skips states missing from `state_values` rather than treating
    a missing state as zero — silently zeroing would bias the aggregate
    toward whichever weight class still has data.

    Spec §4.3.
    """
    states = REGIONS.get(region)
    if states is None:
        raise ValueError(f"Unknown region: {region!r}")
    num = 0.0
    den = 0.0
    for s in states:
        v = state_values.get(s)
        if v is None:
            continue
        w = state_weight(s)
        num += w * v
        den += w
    if den == 0:
        return None
    return num / den


# ---------------------------------------------------------------------------
# Section 4.4: N-day sums over forecast horizons
# ---------------------------------------------------------------------------

HORIZONS = (1, 3, 5, 7, 10, 14)

# Display labels for the panel ("Now" rather than "1d" for the leading column).
HORIZON_LABELS = {
    1: "Now", 3: "3D", 5: "5D", 7: "7D", 10: "10D", 14: "14D",
}


def n_day_sum(
    daily_values: Mapping[date, float],
    start: date,
    n: int,
) -> Optional[float]:
    """Sum daily_values[start..start+n-1] inclusive.

    Returns None if any required date is missing — partial sums would be
    misleading (a 5-day reading that's secretly a 3-day reading). Caller
    decides how to render the gap.

    Spec §4.4.
    """
    total = 0.0
    for i in range(n):
        d = start + timedelta(days=i)
        v = daily_values.get(d)
        if v is None:
            return None
        total += v
    return total


def n_day_min(
    daily_values: Mapping[date, float],
    start: date,
    n: int,
) -> Optional[float]:
    """Minimum of daily_values[start..start+n-1] inclusive. Same partial-window
    rule as n_day_sum: missing data returns None. Used for basin Tmin freeze
    monitoring (spec §4.7)."""
    if n <= 0:
        return None
    seen = []
    for i in range(n):
        d = start + timedelta(days=i)
        v = daily_values.get(d)
        if v is None:
            return None
        seen.append(v)
    return min(seen) if seen else None


# ---------------------------------------------------------------------------
# Section 4.5: Day-over-day forecast revision (apples-to-apples)
# ---------------------------------------------------------------------------

def revision_n_day_sum(
    today_view: Mapping[date, float],
    yesterday_view: Mapping[date, float],
    target_start: date,
    n: int,
) -> Optional[float]:
    """Today's N-day sum minus yesterday's view of the SAME target dates.

    Both `today_view` and `yesterday_view` are mappings target_date→value.
    They came from forecasts issued on different days, but we anchor on
    target dates so the windows are identical.

    Returns None if either side is missing data for any target date — we
    refuse to emit a partial revision because the user has no way to see
    that something is missing in a single number.

    Spec §4.5.
    """
    today_sum = n_day_sum(today_view, target_start, n)
    if today_sum is None:
        return None
    yesterday_sum = n_day_sum(yesterday_view, target_start, n)
    if yesterday_sum is None:
        return None
    return today_sum - yesterday_sum


# ---------------------------------------------------------------------------
# Section 4.6: Modified Z-score (Iglewicz & Hoaglin 1993)
# ---------------------------------------------------------------------------

MIN_BASELINE_N = 30

# 0.6745 is the 75th percentile of the standard normal — the constant that
# makes the modified Z-score comparable in scale to a parametric z-score for
# normally-distributed input. Hardcoded and named because a future reader
# WILL ask "why this magic number" otherwise.
MZ_CONSTANT = 0.6745


def modified_z(
    value: float,
    baseline: Sequence[float],
) -> Optional[float]:
    """Modified Z-score of `value` against `baseline`. Spec §4.6.

    Returns None when len(baseline) < MIN_BASELINE_N (meaningless) or when
    MAD is 0 (degenerate distribution — all values identical).
    """
    if len(baseline) < MIN_BASELINE_N:
        return None
    med = _median(baseline)
    abs_devs = [abs(b - med) for b in baseline]
    mad = _median(abs_devs)
    if mad == 0:
        return None
    return MZ_CONSTANT * (value - med) / mad


# ---------------------------------------------------------------------------
# Convenience: build a per-region per-horizon HDD/CDD panel slice for a
# single forecast issuance, given pre-aggregated state-level dailies.
# Used by service.py to build the panel response.
# ---------------------------------------------------------------------------

def build_region_panel(
    forecast_date: date,
    state_hdd: Mapping[str, Mapping[date, float]],
    state_cdd: Mapping[str, Mapping[date, float]],
) -> Dict[str, Dict[str, Dict[str, Optional[float]]]]:
    """Build the {region → {horizon_label → {hdd, cdd}}} structure for the panel.

    Inputs:
      state_hdd[state][target_date] = HDD value
      state_cdd[state][target_date] = CDD value

    Output (example):
      {
        "national": {
          "Now": {"hdd": 38.0, "cdd": 0.0},
          "3D":  {"hdd": 115.0, "cdd": 0.0},
          ...
        },
        "NE": { ... },
        ...
      }

    A region/horizon cell with insufficient data is `None` rather than 0.
    """
    out: Dict[str, Dict[str, Dict[str, Optional[float]]]] = {}
    for region in REGIONS:
        # Aggregate to region-level dailies first.
        region_hdd_daily: Dict[date, float] = {}
        region_cdd_daily: Dict[date, float] = {}
        # The set of target dates covered by ALL contributing states.
        target_dates = set()
        for s in REGIONS[region]:
            target_dates.update(state_hdd.get(s, {}).keys())
            target_dates.update(state_cdd.get(s, {}).keys())
        for d in sorted(target_dates):
            sv_hdd = {s: state_hdd.get(s, {}).get(d) for s in REGIONS[region]}
            sv_hdd = {k: v for k, v in sv_hdd.items() if v is not None}
            sv_cdd = {s: state_cdd.get(s, {}).get(d) for s in REGIONS[region]}
            sv_cdd = {k: v for k, v in sv_cdd.items() if v is not None}
            agg_h = aggregate_region(region, sv_hdd)
            agg_c = aggregate_region(region, sv_cdd)
            if agg_h is not None:
                region_hdd_daily[d] = agg_h
            if agg_c is not None:
                region_cdd_daily[d] = agg_c

        # Compute N-day sums per horizon. "Now" (N=1) = today's value.
        # All other horizons (3D/5D/7D/10D/14D) are FORWARD-LOOKING: days 1
        # through N, which means forecast_date+1 through forecast_date+N.
        # This matches NWS/NOAA "Day 1-N" convention and how gas traders
        # interpret horizon labels (a "7-day" forecast is the next 7 days,
        # not 6 plus today).
        per_horizon: Dict[str, Dict[str, Optional[float]]] = {}
        for n in HORIZONS:
            label = HORIZON_LABELS[n]
            if n == 1:
                start = forecast_date
                window = 1
            else:
                start = forecast_date + timedelta(days=1)
                window = n
            per_horizon[label] = {
                "hdd": n_day_sum(region_hdd_daily, start, window),
                "cdd": n_day_sum(region_cdd_daily, start, window),
            }
        out[region] = per_horizon
    return out
