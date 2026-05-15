"""Probe Open-Meteo Previous Runs API to verify it returns real vintage
forecasts at multiple lead times (used to scope Phase 2 weather backfill)."""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from collections import defaultdict


URL = (
    "https://previous-runs-api.open-meteo.com/v1/forecast"
    "?latitude=32.78&longitude=-96.80"
    "&start_date=2023-01-10&end_date=2023-01-17"
    "&hourly=temperature_2m,temperature_2m_previous_day1,"
    "temperature_2m_previous_day3,temperature_2m_previous_day7"
    "&temperature_unit=fahrenheit&timezone=America/Chicago&models=gfs_seamless"
)


def main() -> int:
    with urllib.request.urlopen(URL, timeout=30) as r:
        d = json.loads(r.read())
    if d.get("error"):
        print("ERR:", d["reason"]); return 1
    h = d["hourly"]
    print(f"hours returned: {len(h['time'])}")

    keys = [
        ("cur", "temperature_2m"),
        ("d1", "temperature_2m_previous_day1"),
        ("d3", "temperature_2m_previous_day3"),
        ("d7", "temperature_2m_previous_day7"),
    ]
    by_day = defaultdict(lambda: {k: [] for k, _ in keys})
    for i, t in enumerate(h["time"]):
        day = t[:10]
        for k, field in keys:
            v = h[field][i]
            if v is not None:
                by_day[day][k].append(v)
    for d in sorted(by_day):
        r = by_day[d]
        def fmt(xs):
            return f"{min(xs):.0f}/{max(xs):.0f}" if xs else "--"
        cells = " ".join(f"{k}={fmt(r[k])}" for k, _ in keys)
        print(f"{d}  {cells}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
