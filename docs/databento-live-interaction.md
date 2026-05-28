# Databento Live Interaction — Trade Chart "Live" Mode

This document specifies exactly how Trade Chart consumes **Databento** for
**live mode**: how it selects the contract to stream, how it opens and manages
the Databento Live session, how it converts inbound records into chart bars,
and the operational rules that keep the feed healthy. It is written so that a
separate system can reproduce this behavior independently and, if later
merged into this codebase, match it exactly.

**Scope.** Live mode only. The historical **volume-splice continuous-contract
roll** is deliberately *out of scope* — it is replay-mode logic and is **not**
used by live mode. Live streams a single front-month contract for each asset.
(If you need the splice roll, see the README "Volume-splice methodology"
section.)

**Authoritative source files** (this document describes their behavior; the
code is the source of truth):

| Concern | File / symbol |
|---|---|
| Front-month resolution | `server/splice.py` — `resolve_front_month`, `enumerate_contracts` |
| Live session + record handling | `server/live.py` — `LiveAssetManager` |
| Startup wiring, `start=` anchor | `server/main.py` — `_warm_live_assets`, `_resolve_one_for_warmup` |
| Prime payload (historical bridge) | `server/main.py` — `_build_or_get_prime`, `_build_spliced_bars` |
| WebSocket protocol | `server/main.py` — `/ws/live` (`ws_live`) |
| Asset config | `server/assets.py` — `ASSETS` |
| Known failure modes | `docs/live-feed-known-issues.md` |

---

## 1. Databento account prerequisites

- **Live data access** for the **`GLBX.MDP3`** dataset (CME Globex MDP 3.0).
  All 19 supported assets trade on this single dataset.
- **Session-slot budget.** The Databento **Standard plan allows 10
  concurrent Live sessions per dataset per account.** Trade Chart uses
  exactly **one** (see §3). Each running server process holds 1 slot.
- The **same API key** also drives **Historical** API calls — front-month
  resolution (§4) and the prime payload (§9) both query historical data.
  Live mode therefore needs *both* Historical and Live entitlements.

---

## 2. Two distinct Databento APIs are involved

Live mode is not "just the Live API." It uses both:

| API | Schema | Used for | When |
|---|---|---|---|
| **Historical** | `ohlcv-1d` | Front-month resolution — daily volume per candidate contract | Once, at startup |
| **Historical** | `ohlcv-1s` | Prime payload — last 2 sessions of 1s bars | Per WebSocket subscribe (cached) |
| **Live** | `trades` | The real-time tick stream | Continuous, from startup |

The Live API delivers **individual trade ticks** (`trades` schema). Trade
Chart aggregates those into **1-second OHLCV bars client-side** (§8). It does
*not* subscribe to a `ohlcv-1s` live schema.

---

## 3. Architecture: one session, all assets

Trade Chart opens a **single** `databento.Live` session and streams **all 19
assets through it**. A Live session supports many symbols, so one session = one
slot regardless of asset count. The owning component is `LiveAssetManager`.

```
                       ┌──────────────────────── server process ────────────────────────┐
   Databento Live      │                                                                 │
   gateway             │   LiveAssetManager                                              │
   (GLBX.MDP3) ────────┼──▶ one databento.Live()  ──▶ _on_record callback                │
        trades schema  │      (SDK daemon thread)        │                               │
                       │                                 ├─▶ per-asset 1s aggregator     │
                       │                                 ├─▶ per-asset bar_history deque │
                       │                                 └─▶ fan-out to WS subscriber    │
                       │                                       queues (asyncio)          │
                       └─────────────────────────────────────────────┬───────────────────┘
                                                                      │  /ws/live
                                                            ┌─────────┴─────────┐
                                                       browser A           browser B
```

Consequences:
- **One slot of 10** used — leaves headroom for overlapping restarts.
- One record callback receives **every** asset's records; per-asset dispatch
  is by `instrument_id` (§7).
- Every browser WebSocket is a *subscriber* fanned out from this one session.
  Switching the asset a browser views is a cheap subscriber rebind — no new
  Databento session, no new subscription.

---

## 4. Startup sequence (the whole live path is set up once)

Performed by `_warm_live_assets` at server startup:

1. Compute `today` (the current CME trade date) and the replay `start=`
   anchor (§6).
2. For all 19 assets **in parallel**, resolve the front-month contract via
   `resolve_front_month` (§5). Assets that resolve to no active contract are
   dropped from the live subscription (`warmup_status` records why).
3. Pass the resolved `(asset_symbol, raw_symbol, fallback_raw_symbol,
   start_unix_sec)` tuples to `LiveAssetManager.warm_all`, which performs the
   one-shot **subscribe → start** sequence (§7).

After `warm_all` returns, the session streams until process shutdown. **There
is no mid-run re-resolution, re-subscription, or roll.** The set of streamed
contracts is frozen at startup.

---

## 5. Step 1 — Front-month contract resolution

`resolve_front_month(client, asset, today)` picks the single contract to
stream live for one asset. It uses the **Historical** API (`ohlcv-1d` daily
bars), not Live.

Algorithm:

1. **Enumerate candidates.** Generate all contract symbols whose anchor month
   (first-of-contract-month) falls within **±120 days** of the first day of
   today's month. The ±120-day window is wide enough to always include the
   next active contract even for quarterly cycles (NQ/YM/6E… use `H,M,U,Z` —
   3 months apart) and the 4-monthly platinum cycle (`F,J,N,V`).
   - The asset's valid month codes come from `ASSETS[asset]["month_codes"]`
     in `server/assets.py` (e.g. NG = `FGHJKMNQUVXZ`, NQ = `HMUZ`).
2. **Fetch recent daily volume.** For each candidate, fetch `ohlcv-1d` over
   `[today − 15 days, today + 2 days]`.
3. **Determine the latest shared session.** `latest_date` = the most recent
   date *any* candidate has a daily bar for.
4. **Discard stale candidates.** Skip any candidate whose most recent daily
   bar is **more than 1 day** before `latest_date`. (The 1-day grace absorbs
   within-day publication lag. Without this filter, an expired contract whose
   cached daily bars still hold a weeks-old settlement-day volume spike could
   spuriously beat a currently-trading contract.)
5. **Pick the winner.** Among surviving candidates, choose the one with the
   **highest volume on its most recent daily bar**.
6. Return `(raw_symbol, fallback_raw_symbol)` — both symbology forms (§6) —
   or `None` if no candidate has measurable recent volume.

This is **deliberately simpler than the historical volume-splice roll**: it
makes a single point-in-time "what is trading now" decision, with no spread
stitching and no roll history.

---

## 6. Step 2 — Symbology: two forms per contract

CME futures symbols encode the contract month and year, e.g. `NGM5` =
Natural Gas, June (`M`), year ending in 5. Trade Chart generates **two raw
symbol forms** for every contract:

| Form | Example | Role |
|---|---|---|
| **1-digit year** (`raw_symbol`) | `NGM5` | Primary — what CME Globex actually broadcasts |
| **2-digit year** (`fallback_raw_symbol`) | `NGM25` | Fallback safety net |

Both forms are subscribed to the Live session. The gateway resolves whichever
form it recognizes for a given contract and **rejects the other** with a
`Failed to resolve symbol` error — this is **expected and benign** (§7). With
19 assets × 2 forms, the session subscribes **up to 38 raw symbols**.

The replay `start=` anchor used for the subscription (one shared value for all
assets) is computed as follows by `_warm_live_assets`:

- Base value: **`today_midnight_UTC`** — 00:00:00 UTC of the current date.
  This is chosen to exactly equal the instant where the **Historical `/load`
  path stops** (historical is hard-clamped to `min(end, today_midnight_UTC)`).
  Matching the two means the live chart **butts seamlessly against the
  historical chart** with no gap.
- **Closed-market exception:** if `today_midnight_UTC` falls inside a
  closed-market gap (weekend/holiday — i.e. it is *not* within any session's
  `[open, close]`), the gateway has no instrument definitions to resolve
  against and the subscription would fail. In that case the anchor is
  advanced to the **session open**. No real data is lost — a closed gap has
  no trades.

`start=` is supplied to `subscribe()` in **nanoseconds** (`unix_seconds ×
1e9`). See §13 for the late-in-UTC-day staleness hazard (Bug 3b).

---

## 7. Step 3 — Opening the Live session (`warm_all`)

`LiveAssetManager.warm_all` performs the one-shot setup. **The exact sequence
and threading discipline below are load-bearing — deviating from them has
empirically caused the gateway to deliver zero records.**

### 7.1 The subscribe call

A **single** `subscribe()` call carries **all symbols at once**:

```python
client.subscribe(
    dataset   = "GLBX.MDP3",
    schema    = "trades",
    stype_in  = "raw_symbol",
    symbols   = all_symbols,          # up to 38: 19 assets × {1-digit, 2-digit}
    start     = common_start_ns,      # replay anchor in nanoseconds (§6)
)
```

**Why one call, not one per asset:** the gateway throttles subscription
requests at ~10/sec. Firing 19+ individual `subscribe()` calls in a loop hits
that limit; the subsequent `start()` then races the gateway's delayed
subscription processing and the session can go silent. One `subscribe()` with
a symbol list is a single request — the gateway resolves and dedupes
internally.

### 7.2 The subscribe-then-start ordering

Databento Live **forbids new `start=`-bearing subscriptions after
`client.start()` has been called.** Therefore **every** symbol Trade Chart
will ever stream must be subscribed *before* `start()`. This is the
fundamental reason the front-month set is frozen at startup (§4) and why live
mode cannot auto-roll (§13).

Sequence:

```
client = databento.Live(key=API_KEY)
client.add_callback(_on_record, exception_callback=_on_exception)
client.subscribe(...)        # one call, all symbols, with start=
time.sleep(0.5)              # let the gateway process the subscription
client.start()               # begins delivery
```

### 7.3 Single-thread requirement

**Constructing the client, `add_callback`, `subscribe`, and `start` must all
run on one and the same OS thread.** In this codebase the entire block runs
inside a single `asyncio.to_thread(...)` call. Splitting `subscribe` and
`start` across separate `to_thread` calls — which may land on different
ThreadPoolExecutor workers — has been observed to make the gateway silently
deliver zero records. (See the long comment in `warm_all`, and the matching
proven-good pattern in `scripts/probe_live.py`.)

---

## 8. Step 4 — Record handling (`_on_record`)

The Databento SDK invokes `_on_record(record)` on its **own daemon thread**
(`databento_live`) for every inbound record. Records fall into three handled
categories, dispatched by a substring check on the record's class name (loose
matching for resilience across SDK versions):

### 8.1 Error records (`"Error" in class name`)

The gateway's `ErrorMsg`. The text is extracted (the SDK stashes it under
`.err` / `.msg` / `.message` / `.err_msg` depending on version) and stored in
a bounded `gateway_errors` deque (surfaced via `/live_status`).

- `Failed to resolve symbol …` — **benign and expected** (the unrecognized
  symbology form, §6). Stored, not warned.
- Anything else — notably `Invalid start time …` — logged at WARNING with a
  `GATEWAY ERROR` marker. These are real rejections (see Bug 3b, §13).

### 8.2 Symbol-mapping records (`"SymbolMapping" in class name`)

The gateway's `SymbolMappingMsg`, sent when it resolves a `raw_symbol` to an
`instrument_id`. Trade Chart reads `instrument_id` and the raw symbol (in
`stype_in_symbol` / `stype_out_symbol` / `raw_symbol`, version-dependent) and
records `instrument_id → asset_symbol` in an in-memory map.

**This map is the dispatch key.** A trade record carries only an
`instrument_id`; without a prior `SymbolMappingMsg` the trade cannot be routed
and is dropped. The gateway sends mappings before the trades they apply to.

### 8.3 Trade records

A trade is processed only if it has `size > 0`, a non-null `price`, a
positive `ts_event`, and a positive `instrument_id` **that is already in the
mapping**. Trades for unmapped instruments are silently dropped.

Field conversions:

| DBN field | Conversion | Result |
|---|---|---|
| `price` | `× 1e-9` (DBN int64 fixed-point, scale 1e-9) | float price |
| `ts_event` | `// 1e9` | unix **seconds** |
| `ts_event` → trade date | `trade_date_for_instant(...)` (CME 18:00 ET session model) | `YYYY-MM-DD` |

The trade is then folded into that asset's 1-second aggregator (§9).

> Note: `records_received` counts **every** record (system, mapping, error,
> trade); `trades_received` counts only dispatched trades. Both are exposed by
> `/live_status` for diagnostics.

---

## 9. Step 5 — 1-second aggregation and bar payload

Each asset has a `_BarAggregator` that folds trades into **1-second OHLCV
buckets** keyed by the integer unix-second:

- A trade in the current bucket updates `high`/`low`/`close` and adds `size`
  to `volume`.
- A trade in a later bucket **finalizes** the current bucket (emitted with
  `final: true`) and opens a new one.
- Every trade also emits the in-progress bucket with `final: false` so the
  chart's forming bar updates tick-by-tick.

**Bar message shape** (sent over the WebSocket — identical to the historical
`/load` bar shape so the frontend treats both feeds uniformly):

```jsonc
{
  "type": "bar",
  "final": false,            // true = bucket complete, false = in-progress
  "asset": "NG",             // routing tag (frontend filters by this)
  "bar": {
    "t": 1747000000,         // bucket start, unix SECONDS
    "o": 3.512, "h": 3.515, "l": 3.511, "c": 3.514,
    "v": 47,                 // total contracts traded in the bucket
    "s": "2026-05-21",       // CME trade date (ISO)
    "k": "NGM5"              // contract raw symbol (1-digit form)
  }
}
```

Finalized bars are also appended to that asset's `bar_history` deque
(§11) and passed to the optional finalized-bar callback (the alert engine).

---

## 10. Concurrency: crossing from the SDK thread to asyncio

`_on_record` runs on the SDK daemon thread; WebSocket subscriber queues live
on the asyncio event loop. Bars cross the boundary via
`asyncio.run_coroutine_threadsafe(queue.put(payload), loop)`. The loop
reference is captured once at startup (`attach_loop`).

**Critical operational rule (GIL starvation).** The SDK's protocol parser
runs on that single daemon thread and needs the GIL to drain the TCP socket.
Any FastAPI endpoint that merely reads in-memory state **must be `async def`**,
not `def` — `def` handlers run on anyio's threadpool, and under sustained
browser polling they starve the SDK thread of GIL time. The socket buffer
then fills, the gateway backpressures, and records stop arriving until the
load subsides. (Heavy endpoints doing real blocking I/O — `/load`, `/ranks` —
stay `def` deliberately.) See the rule comment above the polling endpoints in
`server/main.py`. Reproduced and fixed 2026-05-05.

---

## 11. Step 6 — Prime payload (the historical → live bridge)

When a browser subscribes to an asset over the WebSocket, the server first
sends a **prime payload**: the last **2 CME trade sessions** (`LIVE_PRIME_DAYS
= 2`) of 1-second bars, in today's front-month price space.

- Built by `_build_or_get_prime` → `_build_spliced_bars(..., narrow_splice=
  True)`, which uses the **Historical** `ohlcv-1s` pipeline.
- This is the **only** place live mode touches splice logic, and only for the
  2-day chart-context lookback — *not* for the live stream itself. The narrow
  splice window just supplies the 2-day chart history; the live tick stream
  runs entirely on the startup-resolved front-month contract.
- Cached per `(asset, today)` on the manager so repeat/concurrent connects
  don't rebuild it.

The prime's last bar plus the Live `start=` replay anchor (§6) together
guarantee **no gap** between historical chart context and the first live bar.

---

## 12. Step 7 — WebSocket protocol and reconnect

One persistent WebSocket (`/ws/live`) per browser session.

**Client → server:**
```jsonc
{ "op": "subscribe",   "asset": "NQ" }
{ "op": "unsubscribe" }
```

**Server → client:**
```jsonc
{ "type": "prime",  "payload": { /* spliced 1s bars, rolls, sessions, meta */ } }
{ "type": "bar",    "final": bool, "asset": "...", "bar": { /* §9 */ } }
{ "type": "status", "message": "..." }
{ "type": "error",  "message": "..." }
```

On `subscribe`: the server detaches the previous asset (if any), sends the
prime, then attaches the WebSocket's queue as a subscriber to that asset.

**Reconnect / asset-switch bridge.** Each asset keeps a `bar_history` deque
(`maxlen = 86400` finalized 1s-bar payloads). On attach, `add_subscriber`
**flushes the full history into the queue first, and only then registers the
queue as a live subscriber** — strictly in that order. This guarantees the
client receives a single time-ordered stream (all history, then all live)
with no live "now" bars interleaved into the flush. (Registering before the
flush completes lets a live bar reach the client ahead of the history bars
that fill the buckets behind it; the client's incremental renderer then jumps
the forming bar forward and leaves an unpainted gap until a full
re-aggregation. The flush-then-register ordering eliminates that.) The flush
is chunked with backpressure; it converges in a few passes, tracking the
delta by bar timestamp. The frontend also dedupes by bar timestamp `t`, so a
re-attaching or asset-switching client backfills the gap between its
(possibly older) prime cutoff and live "now" with no hole and no duplicates.

Every WebSocket is also registered as a **global subscriber** so server-side
alerts broadcast to it regardless of which asset it is currently viewing.

---

## 13. Operational rules and known failure modes

### Session-slot hygiene
- 10 Live slots per dataset per account; each server process holds 1.
- A slot is released **only on a graceful TCP disconnect**. If the process is
  force-killed before `LiveAssetManager.stop()` (→ `client.stop()`) runs, the
  slot leaks until Databento's idle timeout (~5–15 min). Repeated unclean
  restarts can drain all 10 slots — the symptom is a session that
  authenticates but receives **zero records**.
- Graceful shutdown is wired two ways: the FastAPI lifespan `finally` block
  (bounded by a 5 s timeout so a hung `stop()` cannot trigger a force-kill)
  **and** an `atexit` handler (idempotent). Prefer single `Ctrl-C` and wait
  for `Application shutdown complete`; avoid `kill -9` / `taskkill /F`.

### No mid-run roll
The streamed contract set is frozen at `start()` (§7.2 — Databento forbids
new `start=` subscriptions afterward). If the front month rolls during a long
server run, the live feed keeps streaming the **old** contract. **Restart the
server to re-resolve front months.** A WebSocket reconnect alone does not
re-resolve — it only rebuilds the prime.

### Multi-day runs
The `start=` replay anchor is computed once at startup. After UTC midnight it
is stale relative to the advancing archive cutoff. **Restart the server daily**
for clean historical↔live coupling.

### Watchdog
30 s after warm-up, `_live_watchdog` logs a WARNING if `records_received` is
still 0, and writes thread dumps — a silent-gateway diagnostic.

### Known open issues (see `docs/live-feed-known-issues.md` for full detail)
- **Bug 3 — SDK delivery wedge.** Intermittently (notably after a network
  suspend/resume), the Databento SDK buffers *all* inbound records — trades
  *and* its own protocol/error messages — and dispatches them only when
  `client.stop()` runs. The gateway is healthy; the stall is client-side in
  the SDK. A bare-SDK probe reproduces it. Not yet fixed; real recovery would
  need process-level isolation of the Live client.
- **Bug 3b — stale `start=`.** If the server starts late in the UTC day, the
  `start=today_midnight_UTC` replay window can approach ~24 h and cross the
  gateway's retention boundary, drawing an `Invalid start time` rejection.
  Databento Live caps replay at ~24 h. A `LIVE_REPLAY_MAX_SECONDS` constant
  (just under 24 h) exists in `main.py` as a documented cap but is **not
  currently enforced**; a mimicking system should clamp `start=` to "now
  minus ~24 h" (or use `start=0` for live-only, no replay) to be safe.

---

## 14. Checklist for an independent re-implementation

To mimic Trade Chart's live behavior, a separate system must:

1. Hold Databento **Historical + Live** entitlements for **`GLBX.MDP3`**.
2. **Resolve the front month** per asset via recent `ohlcv-1d` daily volume:
   enumerate ±120-day candidates, drop those stale by >1 day vs the latest
   shared session, pick the highest most-recent-bar volume (§5).
3. Generate **both symbology forms** (1-digit and 2-digit year) per contract
   and subscribe both; tolerate `Failed to resolve symbol` for the wrong one
   (§6).
4. Open **one** `databento.Live` session for all assets. Do **one**
   `subscribe()` with the full symbol list, `schema="trades"`,
   `stype_in="raw_symbol"`, and `start=` in nanoseconds; then `start()`.
   Subscribe **before** start; never add `start=` subscriptions after (§7).
5. Run client construction + `add_callback` + `subscribe` + `start` on **one
   thread** (§7.3).
6. Anchor `start=` to `today_midnight_UTC` to butt against historical data,
   advancing to session open when that instant is in a closed-market gap;
   clamp to stay within Databento's ~24 h replay limit (§6, §13).
7. In the record callback: route `SymbolMappingMsg` into an
   `instrument_id → asset` map, surface `ErrorMsg` text, and dispatch trades
   (`price × 1e-9`, `ts_event // 1e9`) only for mapped instruments (§8).
8. Aggregate trades into **1-second OHLCV** buckets, emitting in-progress
   (`final:false`) and completed (`final:true`) bars (§9).
9. Provide a **prime payload** (recent historical 1s bars) so the live chart
   has no gap at the join (§11).
10. Keep a per-asset finalized-bar history for clean reconnect/backfill (§12).
11. Ensure a **graceful disconnect** (`client.stop()`) on every shutdown path
    to release the session slot (§13).
12. Keep in-memory-only HTTP endpoints non-blocking so they don't starve the
    SDK reader thread of the GIL (§10).
