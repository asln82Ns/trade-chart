"""Region definitions, state population weights, basin coordinates.

Mapping rationale and methodology are in docs/weather-data-spec.md §2.
This file is data, not logic — change a coordinate or weight here and the
spec doc MUST be updated to match (see §11 change log).

Phase 1 weights are state population (US Census Bureau 2023 estimates,
rounded to nearest 1000). Phase 2 will swap to EIA Form 176 residential
gas customer counts; only this file changes when that swap happens.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Regional state lists (see spec §2)
# ---------------------------------------------------------------------------

NE_STATES = ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"]
MW_STATES = ["IL", "IN", "IA", "KS", "MI", "MN", "MO", "NE", "ND",
             "OH", "SD", "WI"]
WSC_STATES = ["AR", "LA", "OK", "TX"]

# Other lower-48 states (used only for the National aggregate).
OTHER_STATES = ["AL", "AZ", "CA", "CO", "DE", "FL", "GA", "ID", "KY", "MD",
                "MS", "MT", "NV", "NM", "NC", "OR", "SC", "TN", "UT", "VA",
                "WA", "WV", "WY"]

NATIONAL_STATES = NE_STATES + MW_STATES + WSC_STATES + OTHER_STATES

# Region code → state list. The `national` aggregate is the lower-48 union;
# AK and HI are excluded per the spec because they're not on the contiguous
# gas pipeline network.
REGIONS = {
    "NE":       NE_STATES,
    "MW":       MW_STATES,
    "WSC":      WSC_STATES,
    "national": NATIONAL_STATES,
}

# ---------------------------------------------------------------------------
# Per-state representative coordinates (largest population concentration)
# Rationale: temperature at the population concentration is what drives gas
# demand for heating/cooling. Using the geographic centroid would over-weight
# sparsely-populated areas.
# ---------------------------------------------------------------------------

STATE_COORDS = {
    # Northeast
    "CT": (41.76, -72.67),    # Hartford
    "ME": (43.66, -70.26),    # Portland
    "MA": (42.36, -71.06),    # Boston
    "NH": (42.99, -71.46),    # Manchester
    "RI": (41.82, -71.42),    # Providence
    "VT": (44.48, -73.21),    # Burlington
    "NJ": (40.74, -74.17),    # Newark
    "NY": (40.71, -74.01),    # NYC
    "PA": (39.95, -75.17),    # Philadelphia

    # Midwest
    "IL": (41.88, -87.63),    # Chicago
    "IN": (39.77, -86.16),    # Indianapolis
    "IA": (41.59, -93.62),    # Des Moines
    "KS": (37.69, -97.34),    # Wichita
    "MI": (42.33, -83.05),    # Detroit
    "MN": (44.98, -93.27),    # Minneapolis
    "MO": (39.10, -94.58),    # Kansas City
    "NE": (41.26, -95.94),    # Omaha
    "ND": (46.88, -96.79),    # Fargo
    "OH": (39.96, -82.99),    # Columbus
    "SD": (43.55, -96.73),    # Sioux Falls
    "WI": (43.04, -87.91),    # Milwaukee

    # West South Central
    "AR": (34.75, -92.29),    # Little Rock
    "LA": (29.95, -90.07),    # New Orleans
    "OK": (35.47, -97.52),    # Oklahoma City
    "TX": (32.78, -96.80),    # Dallas

    # Other lower-48 (national only)
    "AL": (33.52, -86.81),    # Birmingham
    "AZ": (33.45, -112.07),   # Phoenix
    "CA": (34.05, -118.24),   # Los Angeles
    "CO": (39.74, -104.99),   # Denver
    "DE": (39.74, -75.55),    # Wilmington
    "FL": (25.76, -80.19),    # Miami
    "GA": (33.75, -84.39),    # Atlanta
    "ID": (43.62, -116.20),   # Boise
    "KY": (38.25, -85.76),    # Louisville
    "MD": (39.29, -76.61),    # Baltimore
    "MS": (32.30, -90.18),    # Jackson
    "MT": (45.78, -108.50),   # Billings
    "NV": (36.17, -115.14),   # Las Vegas
    "NM": (35.08, -106.65),   # Albuquerque
    "NC": (35.23, -80.84),    # Charlotte
    "OR": (45.52, -122.68),   # Portland
    "SC": (34.00, -81.03),    # Columbia
    "TN": (36.16, -86.78),    # Nashville
    "UT": (40.76, -111.89),   # Salt Lake City
    "VA": (37.54, -77.44),    # Richmond
    "WA": (47.61, -122.33),   # Seattle
    "WV": (38.35, -81.63),    # Charleston
    "WY": (41.14, -104.82),   # Cheyenne
}

# Sanity check: every state in any region must have a coordinate.
for _s in NATIONAL_STATES:
    assert _s in STATE_COORDS, f"Missing coord for state {_s}"

# ---------------------------------------------------------------------------
# State population (Phase 1 weights). US Census Bureau 2023 estimates,
# rounded to nearest 1000. Source: https://www.census.gov/popest/.
# These are NORMALIZED PER REGION at compute time — exact values matter only
# in proportion to other states in the same region, so ±1% precision is fine.
# ---------------------------------------------------------------------------

STATE_POP_2023 = {
    # Northeast
    "CT": 3_617_000, "ME": 1_395_000, "MA": 7_001_000, "NH": 1_402_000,
    "RI": 1_098_000, "VT":   647_000, "NJ": 9_290_000, "NY": 19_571_000,
    "PA": 12_961_000,

    # Midwest
    "IL": 12_549_000, "IN": 6_862_000, "IA": 3_207_000, "KS": 2_940_000,
    "MI": 10_037_000, "MN": 5_737_000, "MO": 6_196_000, "NE": 1_978_000,
    "ND":    783_000, "OH": 11_785_000, "SD":   919_000, "WI": 5_910_000,

    # West South Central
    "AR": 3_067_000, "LA": 4_574_000, "OK": 4_054_000, "TX": 30_503_000,

    # Other lower-48
    "AL":  5_108_000, "AZ":  7_431_000, "CA": 38_966_000, "CO": 5_877_000,
    "DE":  1_032_000, "FL": 22_610_000, "GA": 11_029_000, "ID": 1_964_000,
    "KY":  4_526_000, "MD":  6_180_000, "MS":  2_940_000, "MT": 1_132_000,
    "NV":  3_194_000, "NM":  2_114_000, "NC": 10_835_000, "OR": 4_233_000,
    "SC":  5_373_000, "TN":  7_126_000, "UT":  3_417_000, "VA": 8_716_000,
    "WA":  7_812_000, "WV":  1_770_000, "WY":    584_000,
}

# Coverage check.
for _s in NATIONAL_STATES:
    assert _s in STATE_POP_2023, f"Missing population for state {_s}"


def state_weight(state: str) -> float:
    """Phase 1 weight = state population. See spec §2 for upgrade path."""
    return float(STATE_POP_2023[state])


# ---------------------------------------------------------------------------
# Production basin coordinates (3 points each, mean-aggregated)
# See spec §2 "Production basin coordinates".
# ---------------------------------------------------------------------------

BASIN_COORDS = {
    "permian": [
        (31.99, -102.08),    # Midland TX
        (32.39, -101.55),    # Big Spring TX
        (32.42, -103.13),    # Hobbs NM
    ],
    "marcellus": [
        (40.98, -77.50),     # State College PA
        (39.63, -79.96),     # Morgantown WV
        (41.42, -75.66),     # Scranton PA
    ],
    "haynesville": [
        (32.51, -93.75),     # Shreveport LA
        (32.31, -94.71),     # Marshall TX
        (33.21, -94.13),     # Texarkana AR
    ],
}

BASINS = list(BASIN_COORDS.keys())
