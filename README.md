# Trade Chart

Browser-based futures **replay simulator + live monitor** for 15 CME-group
contracts. Pulls 1-second OHLCV from Databento, volume-splices contracts
into a continuous price series, computes percentile-rank metrics over a
configurable lookback, and supports threshold-based alerts.

```
┌─────────────┐     HTTP / WS     ┌──────────────────────┐    HTTPS / Live    ┌──────────────┐
│  Browser    │ ◀───────────────▶ │  FastAPI sidecar     │ ◀─────────────────▶│  Databento   │
│  (HTML/JS)  │                   │  + parquet cache     │                    │ Hist + Live  │
└─────────────┘                   └──────────────────────┘                    └──────────────┘
```

## Features

- **15 supported assets** (all GLBX.MDP3): NG, CL, HO, NQ, YM, GC, SI, PL,
  MBT, 6E, 6B, 6C, 6S, 6J, 6N
- Two modes: **Replay** (historical entry-anchored playback with simulated
  trading) and **Live** (real-time bars on today's volume-leader contract)
- All 15 assets stream on **one Databento Live connection** (1 of the 10
  Standard-plan slots), pre-warmed at startup
- Timeframes: 1m, 5m, 15m, 30m, 1h, 90m, 3h, 4h, 1D
- All times shown in **America/New_York** (ET)
- 1-second tape source — bars build live as the replay plays or live ticks
  arrive
- **Volume-splice** continuous-contract construction with marker on each roll
- Volume histogram pane synced to candles
- Y-axis labels every **10 ticks** (`minMove = 10 × tick_size`)
- Trade simulation with 200ms slippage window, per-asset point value
- **Tick value** + **Dollar Risk** displayed alongside Qty (Risk = distance
  from close to bar's adverse extreme × point value)
- **$ Target** input auto-computes Qty as `floor(target ÷ Risk)` on each tick
- **Percentile-rank metrics** (Vol Rank, Vol Pending, Range Rank, Range
  Pending) computed against a rolling lookback (default 365 days) with a
  per-bucket within-bar profile estimator
- **Alert system**: threshold-based on any rank metric; per-asset or "All"
  fan-out; rising-edge re-fire; persistent top-of-screen banner (30s) +
  audible beep; click chip or banner to switch chart to that asset/timeframe
- Color-coded alert chips: green when in alert state, red ≤5pp from
  threshold, yellow ≤10pp, default otherwise

## Setup

### 1. Backend

```bash
pip install -r requirements.txt
cp .env.example .env
# edit .env, paste your DATABENTO_API_KEY

# For active live testing (no auto-reload — most reliable shutdown):
python -m uvicorn server.main:app --port 8001

# For non-live work (replay UI tweaks, ranks, etc. — auto-reloads on save):
python -m uvicorn server.main:app --reload --port 8001
```

On startup the server pre-warms (in parallel) the splice schedule + active
contract for every asset, opens a single Databento Live session subscribed
to all 30 raw_symbols (15 × {1-digit, 2-digit fallback}), then sequentially
pre-builds the **5m rank cache** for all 15 assets in the background. After
~5–25 minutes (cold cache) every default-tf chart switch is instant; on
warm-cache restarts the pre-warm completes in seconds.

### Restarting safely (avoiding session-slot exhaustion)

The Databento Standard plan allows **10 concurrent Live sessions per
dataset per account**. Each running uvicorn process holds 1 slot. The
gateway releases a slot when its TCP connection closes — **but only if the
client disconnected gracefully**. If the worker is force-killed before
`LIVE_MANAGER.stop()` runs, the slot stays held until Databento's idle
timeout fires (typically 5–15 min). Repeated unclean restarts can drain
all 10 slots; the symptom is the next session authenticates but receives
**zero records** (visible as `records_received: 0` in `/live_status`, and
the chart stays stuck at the prime payload's last bar).

The lifespan + `atexit` shutdown path in `server/main.py` makes this
unlikely under normal conditions. To stay safe:

- **Close every browser tab pointing at this server BEFORE restarting,
  and only re-open them after `pre-warm: complete`.** Critical for
  reliability. With the browser open at startup, the page-load burst
  (initial `/health`, `/assets`, `/alerts`, `/live_status` calls plus
  the `/ws/live` handshake) races against the Databento Live SDK's
  first-second buffer drain. Under combined load with rank pre-warm,
  the SDK's daemon thread can lose enough GIL time that the kernel
  TCP buffer fills, the gateway throttles, and the live feed freezes
  silently for the rest of the session — same `records_received: 0`
  symptom as slot exhaustion, but a different cause and **no probe
  script will detect it** because the gateway is healthy. The fix is
  procedural: shut server → close tabs → start server → wait for
  `pre-warm: complete` (or just for `LiveAssetManager: 1000 records
  received` in the log) → THEN open the browser. Reproduced and
  documented 2026-05-05; a permanent in-server auto-retry fix is
  noted as TODO in `_live_watchdog`.
- **Single `Ctrl-C`, then wait** for `Application shutdown complete`
  before restarting. Pressing Ctrl-C twice escalates to SIGKILL and
  bypasses the cleanup.
- **Avoid `kill -9 <pid>` / `taskkill /F`** — same problem.
- **Prefer plain `uvicorn` over `--reload`** when you're actively
  watching live data. `--reload` reaps the worker more aggressively on
  file changes; plain mode only reacts to your explicit Ctrl-C.
- **Use `--reload` for non-live work** (replay UI, ranks, layout) where
  briefly losing the live feed during reload doesn't matter.

If the gateway is silent, the server logs a `WARNING server: Live gateway
delivered 0 records 30s after session start…` from the watchdog. There are
two distinct failure modes that produce the same symptom (`records_received:
0` in `/live_status`, chart stuck at the prime cutoff). Use the diagnostic
ladder in `scripts/probe_live.py` to tell them apart in 60 seconds:

```bash
# Test 1 — gateway healthy at all? (1 symbol, no replay)
python scripts/probe_live.py NG

# Test 2 — replay path healthy? (1 symbol + replay window)
python scripts/probe_live.py NG --start-seconds-back 7200

# Test 3 — full main-server replication (15 assets × 2 forms + replay)
python scripts/probe_live.py --all-assets --start-seconds-back 7200
```

How to read the result matrix:

| Test 1 | Test 2 | Test 3 | Diagnosis |
|---|---|---|---|
| ✓ | ✓ | ✓ | Gateway is fully healthy — the main server has a code bug |
| ✓ | ✓ | ✗ | Multi-symbol replay tripped the gateway (rare) |
| ✓ | ✗ | ✗ | Replay mode failing for this account (Databento-side) |
| ✗ | ✗ | ✗ | Account-wide gateway issue — wait or contact Databento |

**Past root causes we've hit and fixed:**

- *All three tests pass but main server gets zero records:* `live.py warm_all`
  was splitting `subscribe()` and `start()` across separate
  `asyncio.to_thread` calls, landing on different worker threads, breaking
  the databento client's thread affinity. Fixed by single-threading the
  whole `construct → add_callback → subscribe → start` sequence in one
  `asyncio.to_thread`. See the long comment in `LiveAssetManager.warm_all`
  for the trace.
- *Probe also returns zero records:* sometimes a transient Databento gateway
  hiccup leaves a session zombified (TCP alive, no data). Wait a few minutes
  and re-run the probe.

### 2. Frontend

In a second terminal:

```bash
python -m http.server 8000
```

Open <http://localhost:8000>.

## Server endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Config check |
| GET | `/assets` | Supported assets with tick / point value / decimals |
| GET | `/splice/{asset}?start&end` | Splice schedule for the window |
| GET | `/load?asset&entry&from&to` | Spliced 1s bars in entry-contract price space |
| GET | `/ranks?asset&timeframe&entry&lookback_days` | Per-bucket distributions + within-bar profiles |
| GET | `/resolve_session?instant` | Map an ISO instant to its CME trade date |
| GET | `/probe?raw_symbol&schema&start&end` | Diagnostic: hit Databento directly with one symbol |
| GET | `/live_status` | LiveAssetManager snapshot (records, instrument map, warmup status) |
| WS  | `/ws/live` | Persistent live channel (per-asset bar streaming + global alert broadcast) |
| GET | `/alerts` | List registered alerts |
| POST | `/alerts?asset&metric&op&threshold&tf&lookback` | Register an alert |
| DELETE | `/alerts/{id}` | Remove one alert |
| DELETE | `/alerts` | Clear all alerts |

Cached parquet files land in `server/data_cache/` (gitignored). Two
caching strategies, picked per schema:

- **`ohlcv-1d`** uses a **rolling per-contract** parquet at
  `cache_dir/rolling/{dataset}/{raw_symbol}/ohlcv-1d.parquet`. Each daily
  bar is stored once and re-used across all callers regardless of the
  request's date range. Survives the daily UTC-midnight rollover that
  would otherwise invalidate exact-keyed cache files. NO `.empty` marker
  for ohlcv-1d — empty contracts get re-queried on each cold-process
  start (cheap, parallel) so a contract that newly starts trading isn't
  permanently masked.
- **`ohlcv-1s`** keeps the original exact `(start, end)`-keyed flat
  parquet (`cache_dir/{dataset}__{symbol}__ohlcv-1s__{start}__{end}.parquet`)
  with a sibling `.empty` marker for never-traded ranges. 1s windows are
  session-bounded and don't share usefully across requests, so the
  flat-file pattern is appropriate.

## Usage

### Replay mode

1. Pick **Asset** and **Entry (ET)** — the datetime that defines the entry
   session (price-space anchor).
2. Pick **Timeframe** and **Lookback** (days for rank distributions).
3. Click **Load**. Backend fetches contracts, splices to a continuous series
   in entry-contract price space, returns bars + roll markers + ranks.
4. Click **Play**. The 1s tape plays at the configured speed multiplier;
   the timeframe bar grows live.
5. Place orders during playback. Slippage uses the high (buy) or low (sell)
   of the 1s bar covering the placement instant.

### Live mode

1. Toggle to **Live**.
2. Pick **Asset** and **Timeframe**.
3. Click **Connect**. Server sends the prime payload (last 2 sessions of
   spliced 1s bars in today's contract price space) and starts streaming
   live ticks. Re-subscribing to the same asset on switch is instant; the
   per-asset bar history flushes from the last prime cutoff to "now" so
   there's no chart gap.

### Alerts

1. Build the alert in the row at top: **Asset** (or "All"), **Metric**
   (Vol/Range × Rank/Pending), **Operator** (≥/≤), **Threshold (%)**,
   **Timeframe**.
2. Click **Add Alert**. The alert chip appears with the current evaluated
   value (`@N%`) and fire count (`×K`).
3. When the metric crosses the threshold from below, a notification banner
   slides down at the top of the screen (persists 30s, dismissible),
   accompanied by an audible beep. Re-fires on each rising-edge re-cross
   (e.g., new bar after the value reset).
4. **Click any chip or banner** to switch the chart to that asset/timeframe.
5. **Clear All** removes every registered alert in one call.

Alerts evaluate server-side on every finalized 1s bar, broadcast over the
WebSocket regardless of which asset the client is currently viewing.

## Data flow (replay)

- Initial load: 10 trading sessions before entry + 5 after.
- Prefetch: at 80% through the loaded forward data, the next 5 sessions are
  fetched in the background and appended to the tape.
- Eviction: when the in-memory tape exceeds 30 sessions, the oldest sessions
  outside the active replay are dropped (chart unaffected).

## Data flow (live)

- All 15 assets are subscribed at server startup with `start =
  today_midnight_UTC` so Databento Live replays from the historical archive
  cutoff to "now," eliminating the chart-gap problem.
- One persistent WebSocket per browser session; surveillance of multiple
  assets and global alert broadcast share the same socket.
- Per-asset `bar_history` deque (24h cap) means a re-attaching subscriber
  catches up cleanly without a hole.

## Volume-splice methodology

For each asset:

1. Enumerate candidate contracts in the splice window.
2. Fetch each contract's `ohlcv-1d` daily volume.
3. Walk the trading sessions in order. Seed the active contract with the
   highest-volume contract in the first session.
4. At each subsequent session S, if `prior_session_volume(next) >
   prior_session_volume(current)`, roll to next. **Forward-only.**
5. At each roll session R: spread = (new contract's 18:00 ET 1s open) -
   (old contract's 18:00 ET 1s open). Subsequent bars are translated by the
   accumulated cumulative spread so the entire series sits in the entry
   contract's price space.
6. If the same-instant 18:00 ET bar is missing for either contract, the roll
   is flagged as `incomplete=True` and rendered with an orange marker (vs
   blue for complete rolls). The spread is set to 0 in that case.

## Project layout

```
trade-chart/
├── index.html
├── css/styles.css
├── js/
│   ├── api-client.js       # HTTP + WebSocket wrapper for the FastAPI sidecar
│   ├── asset-config.js     # per-asset metadata, populated from /assets
│   ├── time-utils.js       # ET formatting + timeframe-aligned bar flooring
│   ├── chart-controller.js
│   ├── playback-engine.js  # replay-mode tape + aggregation
│   ├── live-engine.js      # live-mode aggregation (1s → timeframe)
│   ├── rank-engine.js      # frontend percentile-rank lookup against /ranks data
│   ├── trade-simulator.js
│   └── main.js
├── server/
│   ├── assets.py           # 15-asset config (tick/point/decimals/month codes)
│   ├── sessions.py         # CME session boundary helpers
│   ├── databento_client.py # Historical fetch + rolling (ohlcv-1d) / exact (ohlcv-1s) parquet caching
│   ├── splice.py           # volume-splice schedule construction
│   ├── ranks.py            # /ranks distribution + within-bar profile builder
│   ├── live.py             # LiveAssetManager (one Databento Live session, fan-out)
│   ├── alerts.py           # AlertManager (rising-edge eval, broadcast)
│   ├── main.py             # FastAPI app + startup pre-warm tasks
│   └── data_cache/         # parquet + ranks JSON cache (gitignored)
├── requirements.txt
├── .env.example
└── README.md
```

## Limitations / known gaps

- **Multi-day server runs**: live `start=` anchor and rank-cache `entry`
  are fixed at startup time. After UTC midnight, the historical archive
  cutoff and ranks-by-date both advance — restart uvicorn daily for clean
  semantics, or expect a small chart gap and stale rank distributions.
- **Bid/ask volume split is not available** with the 1s tape (ohlcv-1s only
  provides total volume). To recover the split, switch the recent-1yr window
  to the `trades` schema in `databento_client.py`.
- Slippage precision is bounded by the 1s tape: a 200ms window collapses to
  the high (buy) / low (sell) of the bar covering the placement instant.
- Holidays surface as empty sessions and are skipped naturally.
- Daily (1D) bars anchor to the 18:00 ET CME session open; sub-daily
  timeframes anchor to ET wall-clock midnight.
- A contract roll mid-live-session won't auto-follow; reconnect to pick up
  the new active contract.
- Alerts are in-memory; cleared on server restart. The alert chip's
  `@N% ×K` (latest value, fire count) updates via 5s polling of `/alerts`.
- Rank pre-warm covers only the **5m timeframe**. Other timeframes
  lazy-load on first request — first switch may take 30s–2min on cold
  cache; after that, instant.

## Troubleshooting

- **"Cannot reach API"** — start the uvicorn server (see Setup).
- **"DATABENTO_API_KEY not configured"** — copy `.env.example` to `.env`,
  paste your key, restart uvicorn.
- **CORS error in browser console** — the frontend must be served from
  <http://localhost:8000> or <http://127.0.0.1:8000> (or override
  `CORS_ORIGINS` in `.env`).
- **Empty `/load` response** — try a different entry date; some intraday
  windows (especially right after a holiday) have thin data.
- **`gateway error: Failed to resolve symbol N/15: <X>` at startup** —
  expected. Each asset gets both 1-digit and 2-digit raw_symbol forms; the
  gateway resolves whichever it recognizes and rejects the other. Check the
  immediately following `Mapped instrument_id=N → ASSET (RAW)` lines to
  confirm each asset got a working form.
- **Alert "armed" but never fires** — open `/live_status` and `/alerts` in
  a browser. Check `last_value` on the alert (the chip shows `@N%`); if
  it's well below threshold, the condition simply isn't being met yet. If
  `last_eval_time` is null, the asset isn't streaming (check `/live_status`
  warmup_status and instrument_map).
- **Slow first asset switch** — pre-warm runs 5m only; non-5m timeframes
  lazy-load. On a fresh-cache day-1 boot the pre-warm itself takes longer.
  Watch server logs for `rank pre-warm: <asset> tf=5m ready` to gauge
  progress.
- **Charts stuck at the prime cutoff (e.g. ~19:55 ET) and not updating
  with live ticks** — server's `/live_status` shows `records_received: 0`
  and the watchdog logs `WARNING server: Live gateway delivered 0 records
  30s after session start`. Diagnostic order, cheapest first:
  1. **Close every browser tab pointing at this server, then watch the
     terminal.** If `LiveAssetManager record #1: SystemMsg` appears within
     a second of pressing Ctrl+C *or* simply within a few seconds of
     closing the last tab, the issue is **threadpool/GIL starvation from
     polling endpoints**, not Databento. Any GET handler in
     `server/main.py` that just reads in-memory state must be `async def`,
     not `def`. Sync handlers run on anyio's threadpool and burn GIL
     cycles that the `databento_live` daemon thread needs to drain its
     socket — under sustained polling load the parser stops running and
     records pile up in the kernel buffer until the load drops. See the
     load-bearing comment block above the polling endpoints in
     `server/main.py` for the rule. (Reproduced and fixed 2026-05-05.)
  2. If records flow with no browser, the polling rule is being violated
     somewhere — bisect by setting recently-added handlers back to
     `async def`.
  3. If records still don't flow even with no browser, run the probe
     ladder (`python scripts/probe_live.py NG`,
     `--start-seconds-back 7200`, `--all-assets --start-seconds-back 7200`)
     to localise: probe receives records → server bug; probe also gets 0
     → Databento gateway-side. See "Restarting safely" above for the
     slot-exhaustion matrix.
