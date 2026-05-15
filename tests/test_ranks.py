"""Unit tests for the rank algorithm.

Mirrors the JS rank-engine.js logic so we can verify correctness in Python and
trust the JS port (it's a mechanical translation of the same operations).

Run from project root:
    python -m tests.test_ranks
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from server.ranks import bar_open_et_unix, unix_to_et_hhmm  # noqa: E402


# ---- Reference implementations of the JS rank engine logic ----

def percentile_rank(sorted_arr, value):
    """bisect_right / N * 100 — what % of historical observations are <= value."""
    lo, hi = 0, len(sorted_arr)
    while lo < hi:
        mid = (lo + hi) >> 1
        if sorted_arr[mid] <= value:
            lo = mid + 1
        else:
            hi = mid
    if not sorted_arr:
        return None
    return lo / len(sorted_arr) * 100


def absolute_rank(sorted_arr, value):
    """Position in descending order, 1 = largest. Ties get best rank."""
    lo, hi = 0, len(sorted_arr)
    while lo < hi:
        mid = (lo + hi) >> 1
        if sorted_arr[mid] <= value:
            lo = mid + 1
        else:
            hi = mid
    if not sorted_arr:
        return None
    return (len(sorted_arr) - lo) + 1


def median(sorted_arr):
    n = len(sorted_arr)
    if n == 0:
        return 0
    return sorted_arr[n // 2] if n % 2 else (sorted_arr[n // 2 - 1] + sorted_arr[n // 2]) / 2


def estimate(current, p, profile, med):
    if p <= 0:
        return med
    if p >= 1:
        return current
    last = len(profile) - 1
    idx_f = p * last
    lo = int(idx_f)
    hi = min(lo + 1, last)
    w = idx_f - lo
    f = profile[lo] * (1 - w) + profile[hi] * w
    if f <= 0.001:
        return med
    est = current / f
    if p < 0.10:
        a = p / 0.10
        est = a * est + (1 - a) * med
    return est


# ---- Test harness ----

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
    return abs(a - b) <= tol


# ---- Tests ----

def test_percentile_rank():
    print("percentile_rank:")
    arr = [10, 20, 30, 40, 50]
    check("max value -> 100%", near(percentile_rank(arr, 50), 100))
    check("min value -> 20%", near(percentile_rank(arr, 10), 20))
    check("middle (30) -> 60%", near(percentile_rank(arr, 30), 60))
    check("between 20 and 30 -> 40%", near(percentile_rank(arr, 25), 40))
    check("above all -> 100%", near(percentile_rank(arr, 999), 100))
    check("below all -> 0%", near(percentile_rank(arr, 0), 0))
    check("empty -> None", percentile_rank([], 50) is None)
    # ties
    check("with duplicates value <= 30 -> 80%", near(percentile_rank([10, 20, 30, 30, 50], 30), 80))


def test_absolute_rank():
    print("absolute_rank (1 = largest):")
    arr = [10, 20, 30, 40, 50]
    check("max -> 1", absolute_rank(arr, 50) == 1)
    check("middle (30) -> 3", absolute_rank(arr, 30) == 3)
    check("min -> 5", absolute_rank(arr, 10) == 5)
    check("above all -> 1", absolute_rank(arr, 999) == 1)
    check("below all -> 6", absolute_rank(arr, 0) == 6)
    # ties: best rank (competition ranking — both 30s tie for "rank 2 of 5",
    # since exactly 1 value (50) is strictly greater).
    check("tied with 30 in [10,20,30,30,50] -> 2", absolute_rank([10, 20, 30, 30, 50], 30) == 2)


def test_median():
    print("median:")
    check("odd length", median([1, 2, 3, 4, 5]) == 3)
    check("even length", near(median([1, 2, 3, 4]), 2.5))
    check("single", median([42]) == 42)
    check("empty", median([]) == 0)


def test_estimate_no_clamp():
    print("estimate (no shrinkage; linear profile):")
    # Linear profile f(p) = p (61 sample points).
    profile = [i / 60 for i in range(61)]
    med = 100
    # p = 0.5, current = 50  ->  50/0.5 = 100
    check("p=0.5, cur=50 -> 100", near(estimate(50, 0.5, profile, med), 100))
    # p = 1.0 -> returns current
    check("p=1.0 -> current", near(estimate(75, 1.0, profile, med), 75))
    # p = 0 -> returns median
    check("p=0 -> median", near(estimate(0, 0.0, profile, med), med))


def test_estimate_with_clamp():
    print("estimate (shrinkage clamp under 10%):")
    profile = [i / 60 for i in range(61)]
    med = 149.5
    # p = 0.05, naive = 8/0.05 = 160; alpha = 0.5 -> 0.5*160 + 0.5*149.5 = 154.75
    val = estimate(8, 0.05, profile, med)
    check("p=0.05 cur=8 (clamp) -> 154.75", near(val, 154.75, tol=0.01))
    # p = 0.10 boundary, alpha = 1.0 (no clamp)
    val = estimate(20, 0.10, profile, med)
    check("p=0.10 cur=20 -> 200 (no clamp)", near(val, 200, tol=0.01))
    # p just above 10% should match ~unclamped
    val = estimate(20, 0.11, profile, med)
    check("p=0.11 cur=20 -> 20/0.11 ~= 181.8", near(val, 20 / 0.11, tol=0.5))


def test_estimate_realistic_profile():
    print("estimate (non-uniform profile):")
    # Convex curve: heavy early flow then slowing
    profile = [(i / 60) ** 0.5 for i in range(61)]  # f(p) = sqrt(p)
    med = 1000
    # At p=0.25, f = 0.5; current=500 -> est=1000
    val = estimate(500, 0.25, profile, med)
    check("convex profile mid: cur=500 at p=0.25 -> ~1000", near(val, 1000, tol=1.0))


def test_round_trip_percentile_with_known_distribution():
    print("end-to-end against known distribution:")
    # 247 sessions of historical volumes (= n=247)
    historical = list(range(1000, 1000 + 247))   # 1000..1246
    historical.sort()
    n = len(historical)

    # If today's bar's volume is exactly the median, percentile should be ~50%, abs rank ~124.
    median_val = historical[n // 2]              # 1123 (odd n)
    p_rank = percentile_rank(historical, median_val)
    a_rank = absolute_rank(historical, median_val)
    check(f"median value -> percentile ~50%  (got {p_rank:.1f}%)", 49 < p_rank < 52)
    check(f"median value -> absolute rank ~124 (got {a_rank})", a_rank == 124)

    # Top observation -> 100% / rank 1
    top = historical[-1]
    check("max value -> 100%", percentile_rank(historical, top) == 100)
    check("max value -> rank 1", absolute_rank(historical, top) == 1)

    # Above the max -> 100% / rank 1
    above = top + 1000
    check("above max -> 100%", percentile_rank(historical, above) == 100)
    check("above max -> rank 1", absolute_rank(historical, above) == 1)


def test_et_helpers():
    print("ET helpers:")
    # Wed Jun 4 2025 13:32 UTC = 09:32 EDT
    t = 1749043920
    check("90m floor of 09:32 EDT -> bucket 09:00", unix_to_et_hhmm(bar_open_et_unix(t, 90)) == "09:00")
    check("5m floor of 09:32 EDT -> bucket 09:30", unix_to_et_hhmm(bar_open_et_unix(t, 5)) == "09:30")
    check("1D floor of 09:32 EDT -> bucket 18:00", unix_to_et_hhmm(bar_open_et_unix(t, 1440)) == "18:00")
    # Mon Jan 6 2025 19:30 UTC = 14:30 EST
    t2 = 1736191800
    check("90m floor of 14:30 EST -> bucket 13:30", unix_to_et_hhmm(bar_open_et_unix(t2, 90)) == "13:30")


def main():
    test_percentile_rank()
    test_absolute_rank()
    test_median()
    test_estimate_no_clamp()
    test_estimate_with_clamp()
    test_estimate_realistic_profile()
    test_round_trip_percentile_with_known_distribution()
    test_et_helpers()
    print()
    print(f"  {PASSED} passed, {FAILED} failed")
    sys.exit(0 if FAILED == 0 else 1)


if __name__ == "__main__":
    main()
