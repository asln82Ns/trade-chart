"""Decisive probe: does a non-resolving symbol in a Databento Live
subscription wedge record delivery until the session is stopped?

Unlike scripts/probe_live.py (which only prints AFTER client.stop() and so
cannot tell "streamed while live" from "flushed at teardown"), this probe
prints a timestamped heartbeat *during* the live window, then separately
reports how many records arrived only AFTER stop() was called.

The whole experiment hinges on one number: records_after_stop. If records
arrive steadily during the live window  -> delivery is healthy. If they
stay ~0 during the window and then a burst arrives only once we call
stop() -> delivery was wedged and teardown drained the SDK's buffer
(the "appears the moment I press Ctrl+C" symptom).

Run it TWICE and compare:

    # 1) only symbols we know resolve live -> expect steady flow, ~0 after stop
    python scripts/probe_live_wedge.py CLN6 NQM6 6EM6

    # 2) same list + one symbol we know fails -> expect wedge: ~0 during
    #    the window, big burst only after stop
    python scripts/probe_live_wedge.py CLN6 NQM6 6EM6 CLN26

Live-only (no replay start) on purpose: isolates the symbol-resolution
effect from replay-window size. Pass --seconds to lengthen the window.
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_HERE.parent.parent / ".env")
api_key = os.environ.get("DATABENTO_API_KEY", "").strip()
if not api_key:
    raise SystemExit("DATABENTO_API_KEY not set in .env")

import databento as db  # noqa: E402

# Shared state mutated from the SDK's callback thread. A lock keeps the
# heartbeat reader and the callback writer consistent; the counts are
# tiny so contention is negligible.
_lock = threading.Lock()
_state = {
    "total": 0,
    "trades": 0,
    "first_monotonic": None,   # when the very first record arrived
    "stop_monotonic": None,    # when we called client.stop()
    "after_stop": 0,           # records seen strictly after stop_monotonic
}


def _on_record(record) -> None:
    cls = type(record).__name__
    is_trade = ("Trade" in cls) or (hasattr(record, "price")
                                    and hasattr(record, "size"))
    now = time.monotonic()
    with _lock:
        _state["total"] += 1
        if is_trade:
            _state["trades"] += 1
        if _state["first_monotonic"] is None:
            _state["first_monotonic"] = now
        if _state["stop_monotonic"] is not None and now >= _state["stop_monotonic"]:
            _state["after_stop"] += 1


def _on_exception(exc: BaseException) -> None:
    # The hypothesised wedge surfaces here / as an unretrieved future.
    print(f"  [on_exception] {type(exc).__name__}: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("symbols", nargs="*",
                    help="Exact raw symbols to subscribe (e.g. CLN6 NQM6). "
                         "Add a known-bad one (e.g. CLN26) for the wedge case. "
                         "Omit when using --server-symbols.")
    ap.add_argument("--server-symbols", action="store_true",
                    help="Build the EXACT 32-symbol set the server subscribes "
                         "(raw + 2-digit fallback for every asset, via the "
                         "same resolve_front_month path). Isolates whether "
                         "symbol/failure count is what wedges delivery.")
    ap.add_argument("--seconds", type=int, default=None,
                    help="Live observation window before stop() "
                         "(default 30 live-only, 120 with replay).")
    ap.add_argument("--start-seconds-back", type=int, default=None,
                    metavar="N",
                    help="Request replay starting N seconds before now "
                         "(e.g. 80000 ~= 22h, mirrors the server's "
                         "start=today_midnight_UTC). Default: live-only.")
    ap.add_argument("--dataset", default="GLBX.MDP3")
    ap.add_argument("--concurrent-load", type=int, default=0, metavar="N",
                    help="While the live session runs, drive N background "
                         "asyncio.to_thread workers doing CPU-bound pandas + "
                         "blocking sleeps — faithfully mimics the rank "
                         "pre-warm fan-out running concurrently with live. "
                         "Requires --asyncio-to-thread. 0 = off (default).")
    ap.add_argument("--asyncio-to-thread", action="store_true",
                    help="Faithfully reproduce server/live.py: run an asyncio "
                         "event loop and do create+subscribe+start inside "
                         "`await asyncio.to_thread(...)` (the worker thread is "
                         "released after start()), with the heartbeat as an "
                         "async task. Confirms whether THIS execution context "
                         "is what wedges delivery.")
    args = ap.parse_args()

    if args.server_symbols:
        # Mirror server/live.py warm_all() exactly: raw + 2-digit fallback
        # for every asset, resolved via the same code path.
        from datetime import date
        from server.assets import ASSETS
        from server.databento_client import DatabentoClient
        from server.splice import resolve_front_month
        rc = DatabentoClient(api_key, _HERE.parent.parent / "server" / "data_cache")
        today = date.today()
        symbols = []
        for asset in ASSETS:
            r = resolve_front_month(rc, asset, today)
            if r is None:
                print(f"  WARN: could not resolve {asset}, skipping")
                continue
            raw, fb = r
            symbols.append(raw)
            if fb and fb != raw:
                symbols.append(fb)
        print(f"  built {len(symbols)} server symbols across {len(ASSETS)} assets")
    else:
        symbols = [s.upper() for s in args.symbols]
    if not symbols:
        raise SystemExit("No symbols. Pass raw symbols or use --server-symbols.")
    replay = args.start_seconds_back is not None
    seconds = args.seconds if args.seconds is not None else (120 if replay else 30)

    sub_kwargs = {"dataset": args.dataset, "schema": "trades",
                  "stype_in": "raw_symbol", "symbols": symbols}
    if replay:
        start_unix = int(time.time()) - args.start_seconds_back
        sub_kwargs["start"] = start_unix * 1_000_000_000
        print(f"Subscribing {len(symbols)} symbol(s) REPLAY mode: "
              f"start={start_unix} ({args.start_seconds_back}s back) {symbols}")
    else:
        print(f"Subscribing {len(symbols)} symbol(s) live-only: {symbols}")

    def _heartbeat_sync() -> int:
        t0 = time.monotonic()
        last = 0
        while time.monotonic() - t0 < seconds:
            time.sleep(2)
            with _lock:
                tot, tr, first = (_state["total"], _state["trades"],
                                  _state["first_monotonic"])
            ttf = f"{first - t0:5.1f}s" if first is not None else "  --  "
            print(f"  +{time.monotonic() - t0:5.1f}s  total={tot:<7d} "
                  f"trades={tr:<7d}  first_record_at={ttf}")
            last = tot
        return last

    if args.asyncio_to_thread:
        # Faithful reproduction of server/live.py:296 — create+subscribe+
        # start INSIDE asyncio.to_thread (worker released after start()),
        # event loop running on the main thread, heartbeat as an async task.
        import asyncio

        def _connect_subscribe_start():
            c = db.Live(key=api_key)
            c.add_callback(_on_record, exception_callback=_on_exception)
            c.subscribe(**sub_kwargs)
            time.sleep(0.5)            # mirrors live.py's defensive sleep
            c.start()
            return c

        def _busy_cpu():
            # ~0.4-0.8s of GIL-bound pandas, then a blocking sleep that
            # occupies the executor worker like a slow Databento HTTP call.
            import pandas as pd
            import numpy as np
            for _ in range(6):
                df = pd.DataFrame({"a": np.random.randn(200_000),
                                   "b": np.random.randint(0, 500, 200_000)})
                df.groupby("b")["a"].agg(["mean", "std", "sum"])
                df["a"].rolling(50).mean()
                df.sort_values("a")
            time.sleep(0.5)  # mimic blocking Historical HTTP

        async def _load_worker(deadline: float):
            # Mirrors _prewarm_ranks_background: serial `await
            # asyncio.to_thread(heavy)` calls for the whole session.
            while time.monotonic() < deadline:
                await asyncio.to_thread(_busy_cpu)

        async def _amain():
            print("Mode: asyncio.to_thread (server-faithful)"
                  + (f" + concurrent-load×{args.concurrent_load}"
                     if args.concurrent_load else ""))
            client = await asyncio.to_thread(_connect_subscribe_start)
            t0 = time.monotonic()
            load_tasks = []
            if args.concurrent_load:
                deadline = t0 + seconds
                load_tasks = [asyncio.create_task(_load_worker(deadline))
                              for _ in range(args.concurrent_load)]
            print(f"Started. Watching {seconds}s — heartbeat every 2s:")
            last = 0
            while time.monotonic() - t0 < seconds:
                await asyncio.sleep(2)
                with _lock:
                    tot, tr, first = (_state["total"], _state["trades"],
                                      _state["first_monotonic"])
                ttf = f"{first - t0:5.1f}s" if first is not None else "  --  "
                print(f"  +{time.monotonic() - t0:5.1f}s  total={tot:<7d} "
                      f"trades={tr:<7d}  first_record_at={ttf}")
                last = tot
            for lt in load_tasks:
                lt.cancel()
            with _lock:
                _state["stop_monotonic"] = time.monotonic()
            print("Calling client.stop() now…")
            try:
                client.stop()
            except Exception as e:
                print(f"  (stop raised: {e!r})")
            await asyncio.sleep(3)
            return last

        pre_stop_total = asyncio.run(_amain())
    else:
        client = db.Live(key=api_key)
        client.add_callback(_on_record, exception_callback=_on_exception)
        client.subscribe(**sub_kwargs)
        client.start()
        print(f"Started. Watching {seconds}s — heartbeat every 2s "
              f"(this is BEFORE any stop()):")
        pre_stop_total = _heartbeat_sync()
        with _lock:
            _state["stop_monotonic"] = time.monotonic()
        print("Calling client.stop() now…")
        try:
            client.stop()
        except Exception as e:
            print(f"  (stop raised: {e!r})")
        time.sleep(3)

    with _lock:
        s = dict(_state)

    print()
    print("=== Result ===")
    print(f"  total records:            {s['total']}")
    print(f"  trades:                   {s['trades']}")
    print(f"  records during live window:{pre_stop_total}")
    print(f"  records AFTER stop():     {s['after_stop']}")
    print()
    if s["total"] == 0:
        print("VERDICT: nothing at all — gateway/slot/symbol issue, re-run "
              "after a few minutes (separate from the wedge question).")
        return 1
    if s["after_stop"] > 0 and pre_stop_total == 0:
        print("VERDICT: WEDGE CONFIRMED. Zero records while the session was "
              "live; the burst arrived only when stop() drained the SDK "
              "buffer — i.e. this run's execution context blocks delivery.")
        return 2
    if pre_stop_total > 0 and s["after_stop"] <= pre_stop_total:
        print("VERDICT: HEALTHY. Records flowed during the live window — "
              "no wedge for this symbol set.")
        return 0
    print("VERDICT: ambiguous — inspect the heartbeat above.")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
