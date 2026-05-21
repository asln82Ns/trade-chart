# Live feed — known issues, what's been tested, open theories

Working notes from an extended 2026-05-17/18 debugging session. **Read the
"Methodological caution" section before treating anything here as settled.**

## Session status (end of 2026-05-20)

- Bug 1 (Sunday weekend no-resolve): FIXED, holding.
- Bug 2 (Historical/live chart gap): FIXED.
- Bug 3 (live "wedge", records only on Ctrl+C): **OPEN — root cause
  narrowed.** Reproduced repeatedly 2026-05-20. Now understood as a
  client-side Databento SDK delivery stall (the SDK buffers everything and
  drains only on `client.stop()`). Not yet fixed. See the Bug 3 section.
- Bug 3b (stale replay `start=` → gateway "Invalid start time"): **NEW,
  confirmed, separate from the wedge, not yet fixed.** See Bug 3 section.
- Bug 4 (CL `.empty`-marker poisoning): FIXED 2026-05-18; **RECURRED
  2026-05-20** via a different path (`data_end_after_available_end` at the
  UTC-midnight boundary) and re-fixed. See the Bug 4 section.
- Pre-existing dead-contract/decade-collision splice storm: still OPEN,
  separately tracked (bottom of this doc).

## Methodological caution

- "Tested healthy in the probe" means **that variable, in isolation or in the
  combinations explicitly listed**, did not reproduce the bug. It does **not**
  prove that variable is innocent in the full server, in other combinations,
  or over time. Do **not** use this doc to permanently exclude an area.
- The wedge (Bug 3) reproduced repeatedly on 2026-05-20 and its root cause
  is now narrowed (client-side SDK delivery stall), though not yet fixed.

## Bug 1 — Sunday/weekend: live symbols never resolve (FIXED, holding)

- Symptom: on a Sunday cold start, every Live symbol 422'd; no live data.
- Cause: `backfill_start` was anchored to `today_midnight_utc`, which on a
  weekend maps into the closed-market gap where Databento Live has no
  instrument definitions to resolve against.
- Fix: `server/main.py` `_warm_live_assets` — keep `backfill_start =
  today_midnight_utc` (so it stays coupled to the Historical `_clamp_end`,
  avoiding a chart gap), but if that instant is NOT inside a session
  `[session_open_utc, session_close_utc]`, advance to the session open.
- Status: appears effective in subsequent runs (symbols resolve, live flows).

## Bug 2 — Chart gap between Historical and live (FIXED)

- Symptom: chart had ~22h gap (prior-evening → next session) on weekday
  evening starts.
- Cause: an earlier change anchored the live replay to `session_open_utc`,
  which decoupled it from the Historical `/load` clamp (`_clamp_end` =
  `today_midnight_utc`).
- Fix: re-coupled to `today_midnight_utc` (same edit as Bug 1).

## Bug 3 — Live "wedge": records only delivered on Ctrl+C (OPEN — root cause narrowed)

### Status (end of 2026-05-20)

Reproduced repeatedly on 2026-05-20. Root cause NARROWED to the Databento
SDK's client-side delivery path. Not yet fixed. Diagnostics improved this
session (see "Applied this session").

### Confirmed symptom (corrected understanding)

The server subscribes and starts; zero records arrive. The feed stays
silent indefinitely. When the operator presses Ctrl+C, the ENTIRE buffered
stream — trade records, SymbolMappingMsgs, SystemMsgs, AND the gateway's
own protocol/error messages — flushes in <100 ms, then the process shuts
down.

CRITICAL CORRECTION: earlier notes (and several mid-debugging hypotheses)
read the post-Ctrl+C burst as "the gateway finally responding" or as a
coincidence of log ordering. It is neither. The operator confirms that in
EVERY wedged run ever observed, the burst appears only after the Ctrl+C
keypress. The log ordering — burst lines, then `INFO: Shutting down` — is
write ordering, not causation: `client.stop()` runs inside the lifespan
shutdown, drains the SDK's buffer (emitting all the held log lines), and
only then does uvicorn print "Shutting down".

Conclusion: the gateway responds immediately and normally. The stall is
entirely client-side — the Databento SDK receives the bytes but does not
dispatch them to our `_on_record` callback (nor emit its own protocol-layer
log lines) until `client.stop()` forces a drain.

### Evidence

- `scripts/probe_live_wedge.py` (a bare `db.Live()` in a SEPARATE process,
  no server code) ALSO wedged — 0 records during its live window, 0 after
  stop — during the same window the server was wedged. So the wedge is NOT
  specific to our server code; it is environmental / machine-level (SDK +
  OS network state on that machine at that time).
- faulthandler thread dumps (`thread_dump_*.txt`) consistently show OUR
  Python code healthy and the SDK's internal asyncio loop thread idle in
  `windows_events.py:_poll` — the loop has nothing to do, not parked on a
  lock/queue. faulthandler cannot see C-level frames, so it cannot show
  whether the SDK's socket read is being called at all.

### Trigger

Intermittent. Reliably provoked by: run server with ethernet (docking
station) → unplug dock + sleep laptop → wake + replug → Ctrl+C the server
(it hangs; terminal must be killed) → restart. The wedge then often hits
immediately. Plain restarts with no sleep/network-loss cycle usually work.
The sleep/resume cycle leaves the OS network stack and/or the SDK in a
state that exposes the bug.

### Bug 3b — stale replay `start=` ("Invalid start time") — SEPARATE, confirmed

Distinct from the wedge, found in the same 2026-05-20 logs. A server that
subscribed at 23:53 UTC with `start=today_midnight_utc` (00:00 UTC) got,
from the gateway:

    Invalid start time. Must be 2026-05-20T00:10:00Z or later, or 0

i.e. the requested replay window predated the gateway's retention
boundary. This is a REAL bug but is NOT the wedge cause — the SDK buffering
hides this error exactly as it hides records, so it surfaces only on the
Ctrl+C drain.

Why `start=` differed between two consecutive runs (`1779235200` vs
`1779321600`, exactly 24 h apart): UTC midnight rolled between them.
Operator is in US Central — run 1 at 18:53 CDT = 23:53 UTC May 20 →
`today_midnight_utc` = 2026-05-20 00:00 UTC; run 2 at 19:19 CDT = 00:19 UTC
May 21 → `today_midnight_utc` = 2026-05-21 00:00 UTC. Both computed
correctly for their wall clock. Run 2's window was only ~19 min of replay,
well inside retention, so it was accepted and the feed worked.

The `start=` bug bites when the server starts late in the UTC day (the
replay window approaches ~24 h and crosses the gateway's retention edge).
Fix direction (NOT yet applied — see "Deliberately not done"): decouple
live `start` from the historical `/load` clamp so live can start at "now"
(or `0` = live-only) while historical covers up to "now". That re-opens
the Bug 2 coupling and must be done carefully to avoid reintroducing that
chart gap.

### Ruled out

- Gateway-side delay / the gateway withholding data — the gateway responds
  immediately; the SDK holds it.
- Databento session-slot exhaustion — records DO arrive, in full, on the
  drain; the slot was alive the whole time.
- A Python-side wedge of our reader/callback — faulthandler shows our code
  healthy.
- (Earlier, via `scripts/probe_live_wedge.py`, probe-tested healthy and
  still not implicated in isolation: dual 1-digit/2-digit symbology,
  replay-window size, symbol/failure count, `asyncio.to_thread` hosting,
  concurrent rank-prewarm CPU/GIL load, the aggregated symbol-resolution
  `BentoError`.)

### Applied this session (2026-05-20)

- `_live_watchdog` warning text corrected — it previously asserted
  "session-slot exhaustion" as the most likely cause, which this session
  disproved. New text states the confirmed SDK-buffering pattern, points
  here, and tells the operator to run `py-spy dump --pid <pid>` while
  still wedged.
- `LiveAssetManager._on_record` now detects gateway ErrorMsg records,
  stores them (bounded deque, exposed via `stats()` / `/live_status` as
  `gateway_errors`), and logs non-benign ones at WARNING with a "GATEWAY
  ERROR" marker. ("Failed to resolve symbol ..." for the 2-digit fallbacks
  is expected — stored but not warned.) Effect: next wedge, when the
  buffer drains on Ctrl+C, a stale-`start=` rejection appears as an
  obvious "GATEWAY ERROR — Invalid start time ..." line instead of being
  buried among the 17 benign fallback-resolution errors.

### Deliberately NOT done (and why)

- Auto-recovery by recreating the `db.Live()` client in-process when the
  watchdog detects silence: the probe (a separate process) also wedged, so
  the bug is not per-client-instance — recreating within the same process
  is unlikely to help. Real recovery would need process-level isolation
  (run the live client in a subprocess that can be killed and respawned).
  That is a deliberate design decision, not a quick fix.
- The `start=` / historical decoupling for Bug 3b: a real fix but a
  coupled, higher-risk change (Bug 2 territory). Deferred to a focused
  change.

### Next steps for Bug 3

1. When it recurs, BEFORE pressing Ctrl+C, run `py-spy dump --pid <pid>`
   on the wedged process. py-spy shows native (C-level) frames that
   faulthandler cannot — this is the missing data point: is the SDK's
   socket read actually being called (and returning nothing), or never
   called at all?
2. Capture the post-drain log and check whether a "GATEWAY ERROR" line
   appears (Bug 3b, stale `start=`) or not (pure SDK wedge with otherwise-
   valid data behind it).
3. Consider reporting upstream to Databento with the now-specific
   description: "SDK buffers all inbound messages — including its own
   protocol log lines — and dispatches them only on `client.stop()`;
   reproduces with a bare `db.Live()` after a network suspend/resume."
4. If recovery is needed before an upstream fix: process-isolate the live
   client.

## Bug 4 — CL `.empty`-marker poisoning (FIXED 2026-05-18; RECURRED + re-fixed 2026-05-20)

- Symptom: CL 90m chart gap 5/15 16:30 ET → 5/18 19:30 ET, with a CLM6→CLN6
  changeover icon. NG/NQ/GC unaffected (they did not roll in-window).
- Root cause (verified in code + logs — TWO compounding defects):
  1. `_fetch_one` swallowed ALL exceptions (incl. a `504 gateway timed
     out` on `CLN6 ohlcv-1s [2026-05-17 22:00..2026-05-19 00:00]`) as an
     empty DataFrame, with no retry and no distinction from genuine
     no-data.
  2. `_fetch_exact` then wrote a sticky `.empty` marker for that
     `(start,end)` key, so every later `/load` of that window returned
     empty WITHOUT refetching — a one-off transient 504 became a
     persistent gap until the key rotated (UTC-day roll) or the marker
     was deleted.
- NOT roll-logic: the roll just made the rolled-TO contract's first wide
  recent-window fetch large/slow → 504-prone. **Any contract** can hit
  this on any transient blip; rollover only elevates the odds.
- **Does NOT affect replay/live mode** — that's the databento Live path;
  this is purely the Historical client (`/load`, splice).
- Fix applied (`server/databento_client.py`):
  - `_fetch_one` now classifies transient transport errors
    (`_TRANSIENT_ERROR_MARKERS`: timeout/502/503/504/connection/…) and
    does a bounded retry (2 retries, 2s/4s backoff). Returns
    `(df, transient_failed)`.
  - `_fetch_exact` skips the `.empty` marker when `transient_failed` —
    so an unrecovered transient self-heals on the next request instead
    of becoming a sticky gap. Genuine empties (422/expired/invalid
    2-digit fallback) are STILL markered (preserves the
    don't-requery-expired-contracts optimization).
  - All 6 `_fetch_one` call sites updated to unpack the tuple; rolling
    path ignores the flag (it never wrote `.empty`) but gains the retry.
- Stale artifact cleared: deleted the poisoned
  `GLBX_MDP3__CLN6__ohlcv-1s__20260517T220000Z__20260519T000000Z.parquet.empty`
  so CL re-fetches now rather than waiting for the UTC-day key rotation.
- Residual uncertainty: not experimentally confirmed whether that CLN6
  window's 504 was transient vs. a window too heavy to ever return. Fix
  is robust either way (retry recovers transient; no-poison means each
  `/load` re-attempts and self-heals on gateway recovery). If 504s prove
  persistent on wide post-roll windows, a future follow-up is to chunk
  the `ohlcv-1s` request — NOT done now (scope).

### Recurrence 2026-05-20 — `data_end_after_available_end` poisoning

CL again rendered an empty chart (only the 2 live bars; historical
`/load CL` returned `0 bars` while every other asset loaded thousands).
Cause: a poisoned marker
`GLBX_MDP3__CLN6__ohlcv-1s__20260518T220000Z__20260521T000000Z.parquet.empty`.

A DIFFERENT path from the 2026-05-18 504 case. `_fetch_exact` clamps the
window end to start-of-today-UTC (`_clamp_end`). When a fetch lands right
at that UTC-midnight boundary, the requested end is briefly ahead of
Databento's published data; Databento returns `data_end_after_available_end`.
`_fetch_one` classified that as a clean empty (`failed=False`), so
`_fetch_exact` wrote a permanent `.empty` marker — discarding 2+ days of
genuinely-available data because the last few minutes were not yet
published. Only CL was hit: its `/load` happened to run in the narrow
window right at 00:00 UTC (timing, not CL-specific). A cache scan found no
other asset poisoned.

Fix applied 2026-05-20:
- Deleted the poisoned marker (CL refetches on the next `/load`).
- `_fetch_one` now returns `do_not_marker_empty=True` for
  `data_end_after_available_end`, so `_fetch_exact` no longer writes a
  `.empty` marker for it — the window self-heals on the next `/load` once
  Databento publishes. `data_start_before_available_start` is left as a
  genuine, markered empty. No effect on the rolling (`ohlcv-1d`) path,
  which ignores the flag.

Not done (scope): the underlying `_clamp_end`-at-midnight timing that makes
the boundary fetch race Databento's publish frontier. The no-poison fix
makes it self-heal, which is sufficient; a tighter clamp would be a
separate change.

## Files touched

### 2026-05-18 session
- `server/main.py`: `_warm_live_assets` backfill anchor (Bug 1/2);
  `_prewarm_ranks_background` records gate (Option B); `_live_watchdog`
  faulthandler dumps (diagnostic).
- `scripts/probe_live_wedge.py`: new instrumented probe (diagnostic only).
- Unchanged and explicitly NOT implicated by testing: the dual 1-digit/
  2-digit symbology design (probe reproduced it healthy).

### 2026-05-20 session (Bug 3 diagnostics — no behavior change to the feed)
- `server/main.py`: `_live_watchdog` warning text rewritten (the old
  "session-slot exhaustion" diagnosis was disproved this session).
- `server/live.py`: `LiveAssetManager` gained `_gateway_errors` (bounded
  deque); `_on_record` detects/stores gateway ErrorMsg records and logs
  non-benign ones as "GATEWAY ERROR"; `stats()` exposes `gateway_errors`.
- `docs/live-feed-known-issues.md`: this update.

## Pre-existing, separately tracked

- NG/CL/NQ "Dead-contract fallback roll" + "truncated daily-volume cache"
  storm: the splice schedule walks past the last available daily bar (data
  horizon) and chains phantom rolls, each a slow 422. Inflates pre-warm
  cost. Real, logged repeatedly, not yet fixed. Suspected amplifier for
  Bug 3's pre-warm load but not its root cause.
