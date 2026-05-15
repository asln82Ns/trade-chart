"""Hands-on accuracy verifier for /ranks output.

What it does:
  1. Reads a rank-cache JSON file from server/data_cache/ranks/.
  2. Picks a few buckets and prints summary stats: n, min/median/max final
     volume and range, the vol_profile and range_profile curves at a few
     checkpoints.
  3. For each bucket, picks a known historical observation and verifies that
     percentile_rank(observation) lands roughly where it should given its
     position in the sorted distribution (sanity check on the data we shipped).

Usage:
  python -m scripts.verify_ranks server/data_cache/ranks/ranks__NG__90__365__2025-06-04.json
  # or omit path to verify every cached file:
  python -m scripts.verify_ranks
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def percentile_rank(sorted_arr, value):
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


def summarize_bucket(key, b):
    n = b["n"]
    vols = b["volumes"]
    rngs = b["ranges"]
    vp = b["vol_profile"]
    rp = b["range_profile"]
    print(f"  bucket {key}  n={n}")
    if n == 0:
        print("    (empty)")
        return
    print(f"    volumes  min={vols[0]:>12,d}  median={vols[n//2]:>12,d}  max={vols[-1]:>12,d}")
    print(f"    ranges   min={rngs[0]:.5f}  median={rngs[n//2]:.5f}  max={rngs[-1]:.5f}")
    # Profile checkpoints at p = 0, 0.25, 0.5, 0.75, 1.0
    last = len(vp) - 1
    samples = [0, last // 4, last // 2, 3 * last // 4, last]
    print("    vol_profile      ", "  ".join(f"f({i/last:.2f})={vp[i]:.3f}" for i in samples))
    print("    range_profile    ", "  ".join(f"f({i/last:.2f})={rp[i]:.3f}" for i in samples))

    # Self-consistency: pick a known obs (the one at position n//4) and
    # verify percentile_rank places it near the expected percentile.
    pos = n // 4
    if pos > 0:
        v = vols[pos]
        pct = percentile_rank(vols, v)
        rank = absolute_rank(vols, v)
        expected_pct = (pos + 1) / n * 100
        delta = abs(pct - expected_pct)
        ok = delta < (100.0 / n) + 1.0  # 1 unit of slop for ties
        flag = "OK" if ok else "MISMATCH"
        print(f"    self-check vol[{pos}]={v}  pct={pct:.1f}%  abs={rank}/{n}  expected~{expected_pct:.1f}%  [{flag}]")


def verify_file(path: Path):
    print(f"\n=== {path.name}")
    data = json.loads(path.read_text())
    print(f"  asset={data['asset']} timeframe={data['timeframe_min']}m")
    print(f"  entry={data['entry']} lookback_days={data['lookback_days']}")
    print(f"  sessions walked={data['n_sessions_walked']}, with data={data['n_sessions_with_data']}")
    print(f"  buckets={len(data['buckets'])}")
    keys = sorted(data["buckets"].keys())
    # Print the first, middle, and last bucket
    if not keys:
        print("  (no buckets)")
        return
    pick = sorted({keys[0], keys[len(keys) // 2], keys[-1]})
    for k in pick:
        summarize_bucket(k, data["buckets"][k])


def main():
    args = sys.argv[1:]
    cache_dir = Path("server/data_cache/ranks")
    if args:
        for p in args:
            verify_file(Path(p))
        return
    if not cache_dir.exists():
        print(f"No rank cache directory at {cache_dir}. Run a /load first.")
        return
    files = sorted(cache_dir.glob("ranks__*.json"))
    if not files:
        print(f"No rank cache files in {cache_dir}.")
        return
    for p in files:
        verify_file(p)


if __name__ == "__main__":
    main()
