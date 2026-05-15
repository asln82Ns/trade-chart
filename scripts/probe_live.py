"""Isolated probe for the Databento Live gateway.

Opens ONE Live session for a single asset (subscribing to BOTH the 1-digit
and 2-digit-year symbology forms, exactly like the main server does),
prints any records received in 15 seconds, then disconnects cleanly.
Lets you distinguish:

  - "Databento Live is healthy and our server has a bug" — probe receives
    SymbolMappingMsg + trade records, but the main server's /live_status
    shows records_received=0.
  - "Databento Live is starving us (slot exhaustion or other gateway-side
    issue)" — probe also receives 0 records, OR receives only ErrorMsg
    records with no SymbolMapping.

Usage:
    python scripts/probe_live.py            # default symbol pair NGM6/NGM26
    python scripts/probe_live.py CL         # asset symbol -> active month
    python scripts/probe_live.py --raw NGM6 # exact raw symbol, no fallback
    python scripts/probe_live.py NG --seconds 30
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

# Make repo root importable so we share the .env via dotenv.
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_HERE.parent.parent / ".env")
api_key = os.environ.get("DATABENTO_API_KEY", "").strip()
if not api_key:
    raise SystemExit("DATABENTO_API_KEY not set in .env")

import databento as db  # noqa: E402


def _record_text(record) -> str:
    """Pull the gateway's text out of an ErrorMsg / SystemMsg record."""
    for attr in ("err", "msg", "message", "err_msg"):
        v = getattr(record, attr, None)
        if v:
            try:
                return v.decode() if isinstance(v, bytes) else str(v)
            except Exception:
                return repr(v)
    return ""


def _resolve_symbols(arg: str) -> list[str]:
    """If arg looks like an asset symbol (NG, CL, …), look up the active
    front month via splice.resolve_front_month and return both 1-digit and
    2-digit forms. If it looks like a raw symbol already, return as-is."""
    # Heuristic: raw symbols include a month-letter and a digit
    # (e.g. "NGM6", "NGM26"). Asset symbols are short and all-letter
    # (or include a digit prefix like "6E").
    upper = arg.upper()
    has_month = any(c.isdigit() for c in upper) and any(
        c in "FGHJKMNQUVXZ" for c in upper
    )
    if has_month and len(upper) >= 4:
        # Treat as raw symbol
        return [upper]
    # Treat as asset symbol → resolve via the same path the server uses.
    from datetime import date  # local import keeps script standalone-ish
    from server.databento_client import DatabentoClient
    from server.splice import resolve_front_month
    client = DatabentoClient(api_key, _HERE.parent.parent / "server" / "data_cache")
    today = date.today()
    result = resolve_front_month(client, upper, today)
    if result is None:
        raise SystemExit(f"Could not resolve front month for asset {upper}")
    raw, fallback = result
    print(f"  asset {upper} → raw={raw}, fallback={fallback}")
    return [raw, fallback] if fallback and fallback != raw else [raw]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("symbol", nargs="?", default="NG",
                    help="Asset (NG, CL, 6E…) or raw symbol (NGM6). "
                         "Default: NG. Ignored if --all-assets is set.")
    ap.add_argument("--raw", action="store_true",
                    help="Treat symbol arg as a raw symbol with NO fallback "
                         "(i.e. don't add the 2-digit-year form).")
    ap.add_argument("--all-assets", action="store_true",
                    help="Subscribe to all 15 supported assets (× 2 forms = "
                         "30 symbols), exactly like the main server. Lets you "
                         "test whether the multi-symbol subscription is what "
                         "trips the gateway.")
    ap.add_argument("--start-seconds-back", type=int, default=None,
                    metavar="N",
                    help="Request replay starting N seconds before now "
                         "(e.g. 7200 = 2 hours back, matches the main "
                         "server's start=today_midnight_UTC pattern). "
                         "Default: no start (live ticks only).")
    ap.add_argument("--seconds", type=int, default=15,
                    help="Wait window in seconds (default: 15).")
    ap.add_argument("--dataset", default="GLBX.MDP3",
                    help="Databento dataset (default: GLBX.MDP3).")
    args = ap.parse_args()

    if args.all_assets:
        # Mirror the main server's enumeration exactly: every supported
        # asset, both 1-digit and 2-digit-year forms.
        from server.assets import ASSETS
        from datetime import date
        from server.databento_client import DatabentoClient
        from server.splice import resolve_front_month
        client_for_resolve = DatabentoClient(
            api_key, _HERE.parent.parent / "server" / "data_cache",
        )
        today = date.today()
        symbols = []
        for asset in ASSETS:
            r = resolve_front_month(client_for_resolve, asset, today)
            if r is None:
                print(f"  WARN: could not resolve {asset}, skipping")
                continue
            raw, fb = r
            symbols.append(raw)
            if fb and fb != raw:
                symbols.append(fb)
        print(f"  resolved {len(symbols)} symbols across {len(ASSETS)} assets")
    elif args.raw:
        symbols = [args.symbol.upper()]
    else:
        symbols = _resolve_symbols(args.symbol)

    counts = {"total": 0, "trade": 0, "mapping": 0, "error": 0, "system": 0,
              "other": 0}
    first_few: list[str] = []
    errors: list[str] = []
    mappings: list[str] = []

    def on_record(record) -> None:
        counts["total"] += 1
        cls = type(record).__name__
        text = _record_text(record)
        if "Trade" in cls or hasattr(record, "price") and hasattr(record, "size"):
            counts["trade"] += 1
        elif "SymbolMapping" in cls:
            counts["mapping"] += 1
            raw = (
                getattr(record, "stype_in_symbol", None)
                or getattr(record, "stype_out_symbol", None)
                or getattr(record, "raw_symbol", None)
            )
            iid = getattr(record, "instrument_id", "?")
            mappings.append(f"{raw} → instrument_id {iid}")
        elif "Error" in cls:
            counts["error"] += 1
            if text:
                errors.append(text)
        elif "System" in cls:
            counts["system"] += 1
        else:
            counts["other"] += 1
        if counts["total"] <= 8:
            label = f"  #{counts['total']}: {cls}"
            if text:
                label += f" — {text}"
            first_few.append(label)

    def on_exception(exc) -> None:
        errors.append(f"{type(exc).__name__}: {exc}")

    sub_kwargs = {
        "dataset": args.dataset,
        "schema": "trades",
        "stype_in": "raw_symbol",
        "symbols": symbols,
    }
    if args.start_seconds_back is not None:
        from datetime import datetime as _dt, timezone as _tz
        start_unix = int(time.time()) - args.start_seconds_back
        sub_kwargs["start"] = start_unix * 1_000_000_000
        print(f"  Replay mode: start={start_unix} "
              f"({_dt.fromtimestamp(start_unix, tz=_tz.utc).isoformat()}, "
              f"{args.start_seconds_back}s back)")
    print(f"Opening Live session: {len(symbols)} symbols, "
          f"{'replay' if 'start' in sub_kwargs else 'live-only'} mode "
          f"(api key starts with {api_key[:5]}…)")
    client = db.Live(key=api_key)
    client.add_callback(on_record, exception_callback=on_exception)
    client.subscribe(**sub_kwargs)
    client.start()
    print(f"Subscribed. Waiting {args.seconds}s for records…")
    time.sleep(args.seconds)
    try:
        client.stop()
    except Exception as e:
        print(f"  (stop raised: {e!r} — benign)")

    print()
    print(f"=== Result: {counts['total']} records in {args.seconds}s ===")
    print(f"  trades:        {counts['trade']}")
    print(f"  symbol maps:   {counts['mapping']}")
    print(f"  errors:        {counts['error']}")
    print(f"  system:        {counts['system']}")
    print(f"  other:         {counts['other']}")
    if first_few:
        print("First few records:")
        for line in first_few:
            print(line)
    if mappings:
        print("Symbol mappings received:")
        for m in mappings:
            print(f"  {m}")
    if errors:
        print("Gateway errors received:")
        for e in errors:
            print(f"  {e}")

    print()
    if counts["mapping"] > 0 and counts["trade"] > 0:
        print("INTERPRETATION: gateway is healthy AND symbology resolved.")
        print("  Records flowing normally. If the main server shows")
        print("  records_received=0, the bug is in trade-chart code.")
        return 0
    if counts["mapping"] > 0 and counts["trade"] == 0:
        print("INTERPRETATION: gateway resolved the symbol but no trades")
        print("  arrived in the window. Could be a thin-trading symbol or")
        print("  off-hours. Try a busier asset (NQ, CL) or a longer window.")
        return 0
    if counts["error"] > 0 and counts["mapping"] == 0:
        print("INTERPRETATION: gateway is responsive but every symbol form")
        print("  failed to resolve. Check that the symbol(s) actually exist:")
        print(f"  symbols tried: {symbols}")
        return 2
    print("INTERPRETATION: gateway delivered nothing useful.")
    print("  Most likely cause: Databento Live session-slot exhaustion or")
    print("  account-side gateway issue. Wait 5-15 min, then re-run.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
