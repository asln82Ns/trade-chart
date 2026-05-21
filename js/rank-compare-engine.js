// Rank Compare panel: for every asset OTHER than the one currently on the
// main chart, compute Vol rank, Range rank, and open-to-close in ticks at the
// same timeframe and same playback position (or hovered bar). Replay only.
//
// Data sources reused 1:1:
//   - /ranks  → per-asset RankEngine (same payload shape as main app)
//   - /load   → per-asset 1s tape; we aggregate one bucket on demand
//
// Lifecycle (mirrors WeatherEngine):
//   - setEnabled(true)  : panel becomes visible; if context is set, kick off
//                         fetches for every other asset.
//   - setContext({...}) : called on asset/tf/entry/lookback change. Clears
//                         per-asset state. If enabled, restart the kickoff.
//   - setPlayhead(t)    : replay tick advanced; recompute rows + maybe prefetch.
//   - setHoverBar(t|null): row values follow the hovered bar; null = snap back.
//
// Reliability notes:
//   - Generation counter blocks late-resolving fetches from a prior context
//     from clobbering the current panel.
//   - Concurrency cap (4) prevents 16 parallel fetches from saturating the
//     server on toggle-on.
//   - Prefetch trigger is the same shape as PlaybackEngine._maybePrefetch:
//     when the playhead is within PREFETCH_BUFFER_SEC of the end of an
//     asset's loaded tape, fetch the next chunk and append.
//   - Errors on one asset don't block other rows — the failed row shows ERR
//     and stays out of the way.
//   - Renders are coalesced through requestAnimationFrame so 60Hz tick
//     callbacks become at most 60 DOM updates per second across all rows.

import RankEngine from './rank-engine.js';
import * as AssetCfg from './asset-config.js';
import { floorToTimeframe } from './time-utils.js';

// Mirrors the constants in main.js so other-asset windows feel "the same"
// as the main chart's window.
const INITIAL_CONTEXT_DAYS = 10;
const INITIAL_FORWARD_DAYS = 5;
const PREFETCH_FORWARD_DAYS = 5;
// Trigger a forward prefetch when the playhead is within this many seconds
// of the end of the loaded tape. 1 day = comfortable margin even at high
// playback speeds (5000 ticks/sec ≈ 17 wall-seconds per market-day).
const PREFETCH_BUFFER_SEC = 86400;
// /ranks does a per-asset ~365-day cold-cache build server-side and is the
// bottleneck — keep this modest so we don't gridlock the splice cache.
// /load is fast (3-5s for a 15-day window); run more in parallel so the OC
// column populates quickly even while ranks are still building.
const RANKS_CONCURRENT = 4;
const BARS_CONCURRENT = 6;

class RankCompareEngine {
    constructor(api, panelEl) {
        this.api = api;
        this.panel = panelEl;
        this.enabled = false;

        // Context (set by main.js on load/asset/tf/entry/lookback change).
        this.currentAsset = null;     // sym to EXCLUDE from comparison list
        this.timeframeMin = null;
        this.entryDate = null;        // YYYY-MM-DD
        this.lookbackDays = null;
        // Initial load window (YYYY-MM-DD). Should mirror what main.js's
        // PlaybackEngine actually loaded — on a resumed session the main
        // window re-centers around lastViewedT, NOT around entry, so seeding
        // from entry alone leaves us with no overlap. Falls back to an
        // entry-centered window if main.js doesn't pass these.
        this.loadFromDate = null;
        this.loadToDate = null;

        // Per-asset state. Keys = symbols other than currentAsset.
        //   {
        //     rankEngine: RankEngine | null,
        //     ranksLoaded: bool, ranksError: bool,
        //     tape: [{t,o,h,l,c,v,s,k}],
        //     tapeError: bool,
        //     loadedFromDate, loadedToDate (YYYY-MM-DD),
        //     loadedToUnix (sec; end-exclusive),
        //     prefetchInflight: bool,
        //     emptyForwardFetches: int,  // safeguard if asset has no fwd data
        //     rowEl, cells: {volEl, rangeEl, ocEl},
        //   }
        this.perAsset = new Map();

        // Cross-toggle cache so flipping the panel off/on doesn't refetch.
        // Cleared whenever context changes (we rebuild against the new
        // (asset|tf|entry|lookback) tuple).
        this.ranksCache = new Map();   // key -> /ranks payload

        // Late-fetch guard: bumped on every context change. Each in-flight
        // fetch carries the gen it was issued under and silently drops if
        // the gen has moved on.
        this.gen = 0;

        // Two independent semaphores. /load was previously sharing a queue
        // with /ranks, which blocked every asset past the first ~3 from
        // having its bars (and therefore the OC column) populate until a
        // slow /ranks slot freed up.
        this._ranksActive = 0;
        this._ranksQueue = [];
        this._barsActive = 0;
        this._barsQueue = [];

        // Playback state.
        this.playheadT = null;
        this.hoverBarT = null;        // null = follow playhead

        // rAF coalescing flag.
        this._renderScheduled = false;

        // Asset list (populated on first kickoff).
        this._otherAssets = [];
    }

    // -------------------- Public API --------------------

    setEnabled(on) {
        const wasEnabled = this.enabled;
        this.enabled = !!on;
        if (this.panel) this.panel.hidden = !this.enabled;
        if (this.enabled && !wasEnabled) {
            // Don't refetch if we already have rows from a prior toggle-on
            // under the same context — context changes go through setContext,
            // which clears perAsset and clears the panel HTML for us.
            if (this.perAsset.size === 0) {
                this._kickoff();
            } else {
                // Re-render so values match the latest playhead/hover.
                this._scheduleRender();
            }
        }
    }

    /** Called on asset/tf/entry/lookback/window change. If anything actually
     *  changed, we bump the generation and (if enabled) restart fetches.
     *
     *  fromDate/toDate (optional) are the per-asset /load window. main.js
     *  should pass its firstLoadedSession/lastLoadedSession so our window
     *  matches the chart's — critical for resumed sessions where the main
     *  window has shifted forward of the original entry. */
    setContext({ asset, timeframeMin, entryDate, lookbackDays, fromDate, toDate }) {
        const same = asset === this.currentAsset
            && timeframeMin === this.timeframeMin
            && entryDate === this.entryDate
            && lookbackDays === this.lookbackDays
            && fromDate === this.loadFromDate
            && toDate === this.loadToDate;
        if (same) return;
        // Detect window-only change: if (asset,tf,entry,lookback) are
        // unchanged we can keep the on-server-cached /ranks payloads in
        // ranksCache — they're keyed by exactly those four fields.
        const ranksContextChanged = asset !== this.currentAsset
            || timeframeMin !== this.timeframeMin
            || entryDate !== this.entryDate
            || lookbackDays !== this.lookbackDays;
        this.currentAsset = asset;
        this.timeframeMin = timeframeMin;
        this.entryDate = entryDate;
        this.lookbackDays = lookbackDays;
        this.loadFromDate = fromDate || null;
        this.loadToDate = toDate || null;
        this.gen++;
        this.perAsset.clear();
        if (ranksContextChanged) this.ranksCache.clear();
        this._ranksQueue.length = 0;
        this._barsQueue.length = 0;
        this.playheadT = null;
        this.hoverBarT = null;
        if (this.enabled) {
            this._kickoff();
        }
    }

    /** Replay tick advanced. Drives both rendering and prefetch. */
    setPlayhead(playheadT) {
        if (!Number.isFinite(playheadT)) return;
        this.playheadT = playheadT;
        if (!this.enabled) return;
        this._maybePrefetch();
        this._scheduleRender();
    }

    /** Cursor moved over a bar (barT = bar.time, already a bucket open).
     *  Pass null on hover-end to snap back to the playhead bucket. */
    setHoverBar(barT) {
        const next = (barT == null || !Number.isFinite(barT)) ? null : barT;
        if (next === this.hoverBarT) return;
        this.hoverBarT = next;
        if (this.enabled) this._scheduleRender();
    }

    /** Hard reset (e.g. mode switch away from replay). */
    clear() {
        this.gen++;
        this.perAsset.clear();
        this._ranksQueue.length = 0;
        this._barsQueue.length = 0;
        this.playheadT = null;
        this.hoverBarT = null;
        this.currentAsset = null;
        this.timeframeMin = null;
        this.entryDate = null;
        this.lookbackDays = null;
        if (this.panel) this.panel.innerHTML = '';
        this._statusEl = null;
    }

    // -------------------- Kickoff + fetch --------------------

    _kickoff() {
        // Need the full context to do anything useful.
        if (!this.currentAsset || !this.timeframeMin || !this.entryDate || !this.lookbackDays) {
            this._renderEmpty('Load a replay session to compare other assets.');
            return;
        }
        let allSyms;
        try { allSyms = AssetCfg.listAssetSymbols(); }
        catch (_) {
            this._renderEmpty('Asset list not yet loaded.');
            return;
        }
        this._otherAssets = allSyms.filter(s => s !== this.currentAsset).sort();
        if (this._otherAssets.length === 0) {
            this._renderEmpty('No other assets configured.');
            return;
        }

        // Use the window main.js loaded if it told us; otherwise fall back
        // to entry-centered. The fallback only matters for the very first
        // toggle-on when main.js hasn't called setContext yet — which we
        // gate against above (we require entryDate to be set).
        const fromDate = this.loadFromDate || addTradeDays(this.entryDate, -INITIAL_CONTEXT_DAYS);
        const toDate = this.loadToDate || addTradeDays(this.entryDate, INITIAL_FORWARD_DAYS);

        this._buildPanelSkeleton(fromDate, toDate);

        const myGen = this.gen;

        for (const sym of this._otherAssets) {
            const state = {
                rankEngine: null,
                ranksLoaded: false,
                ranksError: false,
                tape: [],
                tapeError: false,
                loadedFromDate: fromDate,
                loadedToDate: toDate,
                loadedToUnix: dateEndUnix(toDate),
                prefetchInflight: false,
                emptyForwardFetches: 0,
                rowEl: null,
                cells: null,
            };
            this.perAsset.set(sym, state);
            this._enqueueRanks(() => this._fetchRanks(sym, myGen));
            this._enqueueBars(() => this._fetchInitialBars(sym, myGen, fromDate, toDate));
        }
        // Bind row pointers after the skeleton exists.
        this._bindRowPointers();
        this._updateStatus();
        this._scheduleRender();
    }

    _enqueueRanks(fn) {
        this._ranksQueue.push(fn);
        this._drainRanks();
    }
    _drainRanks() {
        while (this._ranksActive < RANKS_CONCURRENT && this._ranksQueue.length > 0) {
            const fn = this._ranksQueue.shift();
            this._ranksActive++;
            Promise.resolve()
                .then(fn)
                .catch(err => console.warn('[rank-compare] ranks task failed:', err))
                .finally(() => {
                    this._ranksActive--;
                    this._drainRanks();
                });
        }
    }
    _enqueueBars(fn) {
        this._barsQueue.push(fn);
        this._drainBars();
    }
    _drainBars() {
        while (this._barsActive < BARS_CONCURRENT && this._barsQueue.length > 0) {
            const fn = this._barsQueue.shift();
            this._barsActive++;
            Promise.resolve()
                .then(fn)
                .catch(err => console.warn('[rank-compare] bars task failed:', err))
                .finally(() => {
                    this._barsActive--;
                    this._drainBars();
                });
        }
    }

    async _fetchRanks(sym, myGen) {
        if (myGen !== this.gen) return;
        const key = `${sym}|${this.timeframeMin}|${this.entryDate}|${this.lookbackDays}`;
        let data = this.ranksCache.get(key);
        if (!data) {
            try {
                data = await this.api.ranks(sym, this.timeframeMin, this.entryDate, this.lookbackDays);
            } catch (err) {
                if (myGen !== this.gen) return;
                const st = this.perAsset.get(sym);
                if (st) { st.ranksError = true; }
                this._updateStatus();
                this._scheduleRender();
                return;
            }
            if (myGen !== this.gen) return;
            if (data) this.ranksCache.set(key, data);
        }
        if (myGen !== this.gen) return;
        const st = this.perAsset.get(sym);
        if (!st) return;
        const eng = new RankEngine();
        if (data) eng.setData(data);
        st.rankEngine = eng;
        st.ranksLoaded = true;
        this._updateStatus();
        this._scheduleRender();
    }

    async _fetchInitialBars(sym, myGen, fromDate, toDate) {
        if (myGen !== this.gen) return;
        let data;
        try {
            data = await this.api.load(sym, this.entryDate, fromDate, toDate);
        } catch (err) {
            if (myGen !== this.gen) return;
            const st = this.perAsset.get(sym);
            if (st) { st.tapeError = true; }
            this._updateStatus();
            this._scheduleRender();
            return;
        }
        if (myGen !== this.gen) return;
        const st = this.perAsset.get(sym);
        if (!st) return;
        st.tape = (data && data.bars ? data.bars : []).map(b => ({
            t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, s: b.s, k: b.k,
        }));
        // bars from /load are usually already sorted, but be defensive
        st.tape.sort((a, b) => a.t - b.t);
        // Window range fields stay as the initial fromDate/toDate.
        this._updateStatus();
        this._scheduleRender();
    }

    async _prefetchForward(sym, myGen) {
        const st = this.perAsset.get(sym);
        if (!st || st.prefetchInflight) return;
        if (myGen !== this.gen) return;
        st.prefetchInflight = true;
        const fromDate = addTradeDays(st.loadedToDate, 1);
        const toDate = addTradeDays(st.loadedToDate, PREFETCH_FORWARD_DAYS);
        try {
            const data = await this.api.load(sym, this.entryDate, fromDate, toDate);
            if (myGen !== this.gen) return;
            const st2 = this.perAsset.get(sym);
            if (!st2) return;
            const newBars = (data && data.bars ? data.bars : []).map(b => ({
                t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, s: b.s, k: b.k,
            }));
            const lastT = st2.tape.length ? st2.tape[st2.tape.length - 1].t : -Infinity;
            let added = 0;
            for (const b of newBars) {
                if (b.t <= lastT) continue;
                st2.tape.push(b);
                added++;
            }
            st2.loadedToDate = toDate;
            st2.loadedToUnix = dateEndUnix(toDate);
            st2.emptyForwardFetches = added > 0 ? 0 : (st2.emptyForwardFetches + 1);
            this._scheduleRender();
        } catch (err) {
            console.warn(`[rank-compare] prefetch failed for ${sym}:`, err);
            // On error: don't auto-retry forever — count as an empty fetch
            // so the safeguard eventually disables prefetch for this asset.
            const st2 = this.perAsset.get(sym);
            if (st2) st2.emptyForwardFetches++;
        } finally {
            const st2 = this.perAsset.get(sym);
            if (st2) st2.prefetchInflight = false;
        }
    }

    _maybePrefetch() {
        if (this.playheadT == null) return;
        for (const sym of this._otherAssets) {
            const st = this.perAsset.get(sym);
            if (!st) continue;
            if (st.prefetchInflight) continue;
            if (st.emptyForwardFetches >= 3) continue;  // give up on this asset
            if (st.loadedToUnix == null) continue;
            if (this.playheadT < st.loadedToUnix - PREFETCH_BUFFER_SEC) continue;
            // Crossed the watermark — kick off the next chunk via the bars
            // semaphore (it's another /load call, fast).
            const myGen = this.gen;
            this._enqueueBars(() => this._prefetchForward(sym, myGen));
        }
    }

    // -------------------- Rendering --------------------

    _scheduleRender() {
        if (this._renderScheduled) return;
        this._renderScheduled = true;
        // rAF coalesces rapid-fire ticks/hovers into one DOM pass.
        requestAnimationFrame(() => {
            this._renderScheduled = false;
            this._renderRows();
        });
    }

    _renderEmpty(msg) {
        if (!this.panel) return;
        this.panel.innerHTML = `
            <div class="rank-compare-header">RANK COMPARE</div>
            <div class="rank-compare-empty">${escapeHtml(msg)}</div>`;
    }

    _buildPanelSkeleton(fromDate, toDate) {
        if (!this.panel) return;
        const tfLabel = this.timeframeMin ? `${this.timeframeMin}m` : '--';
        const cur = this.currentAsset || '--';
        const window = (fromDate && toDate) ? `${fromDate} → ${toDate}` : '';
        const rows = this._otherAssets.map(sym => `
            <tr data-sym="${escapeHtml(sym)}">
              <td class="col-asset">${escapeHtml(sym)}</td>
              <td class="col-vol rank-loading">…</td>
              <td class="col-range rank-loading">…</td>
              <td class="col-oc rank-loading">…</td>
            </tr>`).join('');
        this.panel.innerHTML = `
            <div class="rank-compare-header">RANK COMPARE · ${escapeHtml(tfLabel)} · vs ${escapeHtml(cur)}</div>
            <div class="rank-compare-status" id="rc-status">Initializing…</div>
            <div class="rank-compare-sub">Window: ${escapeHtml(window || '—')}</div>
            <div class="rank-compare-sub">Vol % (idx/n)  ·  Range % (idx/n)  ·  Open→Close (ticks)</div>
            <table class="rank-compare-table">
              <thead>
                <tr>
                  <th class="col-asset">Sym</th>
                  <th class="col-vol">Vol</th>
                  <th class="col-range">Range</th>
                  <th class="col-oc">OC</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>`;
        this._statusEl = this.panel.querySelector('#rc-status');
    }

    /** Compact live progress line at the top of the panel. Cold-cache /ranks
     *  takes minutes per asset; without a counter the user can't tell
     *  whether the panel is still working or stuck. */
    _updateStatus() {
        if (!this._statusEl) return;
        const total = this._otherAssets.length;
        if (total === 0) { this._statusEl.textContent = ''; return; }
        let ranksDone = 0, barsDone = 0, ranksErr = 0, barsErr = 0;
        for (const sym of this._otherAssets) {
            const st = this.perAsset.get(sym);
            if (!st) continue;
            if (st.ranksLoaded) ranksDone++;
            if (st.ranksError) { ranksErr++; ranksDone++; }     // count errors as resolved
            if (st.tape.length > 0) barsDone++;
            if (st.tapeError) { barsErr++; barsDone++; }
        }
        const errTail = (ranksErr || barsErr) ? ` · ${ranksErr + barsErr} err` : '';
        this._statusEl.textContent =
            `Ranks ${ranksDone}/${total} · Bars ${barsDone}/${total}${errTail}`;
    }

    _bindRowPointers() {
        if (!this.panel) return;
        for (const sym of this._otherAssets) {
            const st = this.perAsset.get(sym);
            if (!st) continue;
            const row = this.panel.querySelector(`tr[data-sym="${cssEscape(sym)}"]`);
            if (!row) continue;
            st.rowEl = row;
            st.cells = {
                volEl:   row.querySelector('.col-vol'),
                rangeEl: row.querySelector('.col-range'),
                ocEl:    row.querySelector('.col-oc'),
            };
        }
    }

    _renderRows() {
        if (!this.enabled) return;
        if (!this.panel) return;
        if (this._otherAssets.length === 0) return;
        if (this.timeframeMin == null) return;

        // Resolve which bucket we're rendering against.
        let bucketT = null;
        let currentTickT = this.playheadT;
        if (this.hoverBarT != null) {
            bucketT = this.hoverBarT;
        } else if (this.playheadT != null) {
            bucketT = floorToTimeframe(this.playheadT, this.timeframeMin);
        }

        for (const sym of this._otherAssets) {
            const st = this.perAsset.get(sym);
            if (!st || !st.cells) continue;
            this._paintRow(sym, st, bucketT, currentTickT);
        }
    }

    _paintRow(sym, st, bucketT, currentTickT) {
        const { volEl, rangeEl, ocEl } = st.cells;

        // Error states take precedence.
        if (st.ranksError && st.tapeError) {
            setText(volEl,   'ERR', 'rank-err');
            setText(rangeEl, 'ERR', 'rank-err');
            setText(ocEl,    'ERR', 'rank-err');
            return;
        }
        if (st.ranksError) {
            setText(volEl,   'ranks ERR', 'rank-err');
            setText(rangeEl, 'ranks ERR', 'rank-err');
        }
        if (st.tapeError) {
            setText(ocEl,    'bars ERR', 'rank-err');
        }

        // Still loading either side — show placeholders.
        const ranksReady = st.ranksLoaded && !st.ranksError && st.rankEngine;
        const tapeReady = !st.tapeError;
        if (!ranksReady) {
            setText(volEl,   '…', 'rank-loading');
            setText(rangeEl, '…', 'rank-loading');
        }
        if (!tapeReady || st.tape.length === 0) {
            setText(ocEl,    !tapeReady ? 'bars ERR' : '…', !tapeReady ? 'rank-err' : 'rank-loading');
            if (!ranksReady) return;
        }

        // No bucket selected yet (panel toggled on before any tick / hover).
        if (bucketT == null) {
            if (ranksReady) {
                setText(volEl,   '—', 'rank-missing');
                setText(rangeEl, '—', 'rank-missing');
            }
            setText(ocEl, '—', 'rank-missing');
            return;
        }

        // Build the bar for this bucket from the tape, clamped to the
        // playhead so future-of-playhead buckets don't peek ahead. When
        // there's no playhead yet (user is hovering pre-Play), use the
        // full bucket — RankEngine.forBar(bar, null) treats it as final.
        const tfSec = this.timeframeMin * 60;
        const bucketEndT = bucketT + tfSec;
        const cutoffT = (currentTickT == null)
            ? bucketEndT
            : Math.min(bucketEndT, currentTickT + 1);
        const bar = aggregateRange(st.tape, bucketT, cutoffT);

        if (!bar) {
            // No 1s data at this bucket for this asset (asset doesn't trade
            // here, or bar is past the loaded window — prefetch will catch up).
            if (ranksReady) {
                setText(volEl,   '—', 'rank-missing');
                setText(rangeEl, '—', 'rank-missing');
            }
            setText(ocEl, '—', 'rank-missing');
            return;
        }

        // RankEngine wants a bar with .time, plus (high, low, volume) — we
        // already provide that.
        bar.time = bucketT;

        if (ranksReady) {
            const r = st.rankEngine.forBar(bar, currentTickT);
            renderRankCell(volEl,   r, 'vol');
            renderRankCell(rangeEl, r, 'range');
        }

        // Open-to-close in ticks.
        const tick = tickSizeFor(sym);
        if (tick && tick > 0) {
            const diffPrice = (bar.close - bar.open);
            const diffTicks = Math.round(diffPrice / tick);
            let cls;
            if (diffTicks > 0) cls = 'oc-pos';
            else if (diffTicks < 0) cls = 'oc-neg';
            else cls = 'oc-zero';
            const sign = diffTicks > 0 ? '+' : '';
            setText(ocEl, `${sign}${diffTicks}t`, cls);
        } else {
            setText(ocEl, '—', 'rank-missing');
        }
    }
}

// -------------------- Helpers --------------------

/** Aggregate every 1s tape entry t with fromT <= t < toT into a single bar.
 *  Returns {open, high, low, close, volume, contract, sessionDate} or null
 *  if the range contains no entries. Binary-search start for O(log n). */
function aggregateRange(tape, fromT, toT) {
    if (!tape || tape.length === 0) return null;
    if (toT <= fromT) return null;
    let lo = 0, hi = tape.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tape[mid].t < fromT) lo = mid + 1;
        else hi = mid;
    }
    let bar = null;
    for (let i = lo; i < tape.length; i++) {
        const tk = tape[i];
        if (tk.t >= toT) break;
        if (!bar) {
            bar = {
                open: tk.o, high: tk.h, low: tk.l, close: tk.c,
                volume: tk.v || 0, contract: tk.k, sessionDate: tk.s,
            };
        } else {
            if (tk.h > bar.high) bar.high = tk.h;
            if (tk.l < bar.low) bar.low = tk.l;
            bar.close = tk.c;
            bar.volume += (tk.v || 0);
        }
    }
    return bar;
}

/** Format a single rank cell. r is the RankEngine.forBar result. */
function renderRankCell(el, r, kind) {
    if (!r || r.missing || r.n === 0) {
        setText(el, '—', 'rank-missing');
        return;
    }
    const pct = kind === 'vol' ? r.volRank : r.rangeRank;
    const idx = kind === 'vol' ? r.volRankIdx : r.rangeRankIdx;
    if (pct == null || idx == null) {
        setText(el, '—', 'rank-missing');
        return;
    }
    const dim = r.lowN ? ' rank-low-n' : '';
    const hot = pct >= 85 ? ' rank-hot' : '';
    el.className = `col-${kind}${dim}`;
    el.innerHTML = `<span class="rank-val${hot}">${pct.toFixed(0)}</span><span class="rank-idx">${idx}/${r.n}</span>`;
}

function setText(el, text, cls) {
    if (!el) return;
    // Preserve the column class so widths stay sane; cls is the state class.
    const colClass = (el.className.match(/\bcol-\w+\b/) || [''])[0];
    el.className = `${colClass} ${cls}`.trim();
    el.textContent = text;
}

/** Naive ET-anchored weekday math; matches main.js _addTradeDays.
 *  Backend gracefully handles holidays (returns no bars for those dates). */
function addTradeDays(yyyymmdd, n) {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    let date = new Date(Date.UTC(y, m - 1, d));
    const step = n >= 0 ? 1 : -1;
    let remaining = Math.abs(n);
    while (remaining > 0) {
        date = new Date(date.getTime() + step * 24 * 3600 * 1000);
        const dow = date.getUTCDay();
        if (dow !== 0 && dow !== 6) remaining--;
    }
    const yy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

/** End-exclusive UTC unix-sec for "YYYY-MM-DD" (start of next UTC day).
 *  We use UTC (not ET) deliberately: this is only used as a coarse
 *  watermark for "do we have enough forward data?" — being a few hours off
 *  for DST in either direction is harmless next to PREFETCH_BUFFER_SEC=1d. */
function dateEndUnix(yyyymmdd) {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d + 1) / 1000);
}

function tickSizeFor(sym) {
    try { return AssetCfg.getAsset(sym).tick_size; }
    catch (_) { return null; }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

/** CSS.escape with a fallback for older browsers — symbols like "6E" need
 *  to round-trip through a querySelector attribute selector. */
function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
}

export default RankCompareEngine;
