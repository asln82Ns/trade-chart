// Trend Status panel: a compact buy/sell-strength readout built purely from
// the bars already on the chart. No network, no cache, no concurrency — the
// entire input is chartController.lastCandleData (the live candle array, kept
// current in-place: appended on each new bar, OHLC-refreshed on the forming
// bar). That makes this the simplest of the opt-in panels.
//
// Classification (bar i vs the bar immediately before it):
//   - Doji (close == open) or no prior bar         -> NEUTRAL  (white block)
//   - Green (close > open):
//       close >= prevHigh                          -> GREEN L3 (green block)
//       else                                       -> NEUTRAL  (white block)
//   - Red (close < open):
//       close <= prevLow                           -> RED L3   (red block)
//       else                                       -> NEUTRAL  (white block)
//
// "At the limit" (close exactly == prevHigh / prevLow) counts as Level 3.
// The gap edge cases need no special handling: a green bar that gaps and
// closes below prevLow simply fails the L3 test and falls through to
// neutral; likewise a red bar that gaps above. One rule covers everything.
//
// Lifecycle (mirrors WeatherEngine):
//   - setEnabled(on)     : show/hide panel; render when shown.
//   - setHoverBar(t|null): render as if bar `t` were the most recent close;
//                          null = follow the live/forming bar.
//   - refresh()          : re-render against the current bar array (called
//                          on every tick and on timeframe change).
//
// Each window renders as a strip of blocks, leftmost = most recent bar.

const MIN_WINDOW = 1;
// UI-readability cap, not a data limit: a full ~23h session is ~276 5-min
// bars, but past ~50 discrete blocks become unreadable slivers in a
// condensed panel. ~50 is ≈4h of 5-min bars — comfortably wider than the
// 34-bar default.
const MAX_WINDOW = 50;
const DEFAULT_WINDOWS = [8, 17];

class TrendStatusEngine {
    /** @param panelEl  outer container; we own its innerHTML.
     *  @param getBars  () => live candle array [{time,open,high,low,close}, …]
     *                  ordered oldest→newest. We never mutate it. */
    constructor(panelEl, getBars) {
        this.panel = panelEl;
        this.getBars = getBars;
        this.enabled = false;
        this.windows = DEFAULT_WINDOWS.slice();
        this.hoverBarT = null;          // null = follow the last (forming) bar
        this._renderScheduled = false;
        this._built = false;            // skeleton (header + inputs) created?
    }

    // -------------------- Public API --------------------

    setEnabled(on) {
        this.enabled = !!on;
        if (this.panel) this.panel.hidden = !this.enabled;
        if (this.enabled) {
            this._built = false;        // rebuild skeleton fresh on each show
            this._scheduleRender();
        }
    }

    /** barT = bar.time (a bucket open). null on hover-end → follow live. */
    setHoverBar(barT) {
        const next = (barT == null || !Number.isFinite(barT)) ? null : barT;
        if (next === this.hoverBarT) return;
        this.hoverBarT = next;
        if (this.enabled) this._scheduleRender();
    }

    /** Re-render against the current bar array (tick / timeframe change). */
    refresh() {
        if (this.enabled) this._scheduleRender();
    }

    setWindows(arr) {
        this.windows = arr.map(n => clampWindow(n));
        if (this.enabled) { this._built = false; this._scheduleRender(); }
    }

    // -------------------- Rendering --------------------

    _scheduleRender() {
        if (this._renderScheduled) return;
        this._renderScheduled = true;
        requestAnimationFrame(() => {
            this._renderScheduled = false;
            this._render();
        });
    }

    _render() {
        if (!this.enabled || !this.panel) return;
        const bars = (typeof this.getBars === 'function' ? this.getBars() : null) || [];

        if (!this._built) this._buildSkeleton();

        const body = this.panel.querySelector('.trend-status-body');
        if (!body) return;

        if (bars.length === 0) {
            body.innerHTML = `<div class="trend-status-empty">Load a session to see trend status.</div>`;
            return;
        }

        // Resolve the reference bar index (the "most recent" / leftmost block).
        let refIdx = bars.length - 1;
        if (this.hoverBarT != null) {
            const i = findBarIndex(bars, this.hoverBarT);
            if (i >= 0) refIdx = i;
        }

        const rows = this.windows.map((w, k) =>
            this._renderWindow(bars, refIdx, w, k + 1)).join('');
        body.innerHTML = rows;
    }

    _renderWindow(bars, refIdx, windowSize, label) {
        // Most-recent-first: block[0] = reference bar, then preceding bars.
        const blocks = [];
        let g = 0, r = 0, n = 0;
        for (let off = 0; off < windowSize; off++) {
            const i = refIdx - off;
            if (i < 0) break;
            const cls = classifyBar(bars[i], i > 0 ? bars[i - 1] : null);
            blocks.push(cls);
            if (cls === 'greenL3') g++;
            else if (cls === 'redL3') r++;
            else n++;
        }
        const total = blocks.length || 1;
        const pct = v => `${Math.round((v / total) * 100)}%`;

        const strip = blocks.map(c =>
            `<span class="ts-block ts-${c}"></span>`).join('');

        return `
            <div class="trend-status-row">
              <div class="ts-label">W${label} · ${windowSize}b</div>
              <div class="ts-strip">${strip}</div>
              <div class="ts-counts">
                <span class="ts-c-g">${g} <small>${pct(g)}</small></span>
                <span class="ts-c-r">${r} <small>${pct(r)}</small></span>
                <span class="ts-c-w">${n} <small>${pct(n)}</small></span>
              </div>
            </div>`;
    }

    _buildSkeleton() {
        if (!this.panel) return;
        const inputs = this.windows.map((w, k) => `
            <label class="ts-cfg-label">W${k + 1}
              <input type="number" class="ts-window-input" data-idx="${k}"
                     min="${MIN_WINDOW}" max="${MAX_WINDOW}" step="1" value="${w}"
                     title="Lookback bars for window ${k + 1} (${MIN_WINDOW}–${MAX_WINDOW}).">
            </label>`).join('');
        this.panel.innerHTML = `
            <div class="trend-status-header">
              <span>TREND STATUS</span>
              <span class="ts-config">${inputs}</span>
            </div>
            <div class="trend-status-legend">
              <span class="ts-block ts-greenL3"></span>buy
              <span class="ts-block ts-redL3"></span>sell
              <span class="ts-block ts-neutral"></span>neutral
            </div>
            <div class="trend-status-body"></div>`;

        for (const inp of this.panel.querySelectorAll('.ts-window-input')) {
            inp.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.idx, 10);
                const val = clampWindow(parseInt(e.target.value, 10));
                e.target.value = val;
                this.windows[idx] = val;
                this._scheduleRender();
            });
        }
        this._built = true;
    }
}

// -------------------- Helpers --------------------

/** Classify `bar` against the bar immediately before it. */
function classifyBar(bar, prev) {
    if (!prev) return 'neutral';
    if (bar.close === bar.open) return 'neutral';   // doji
    if (bar.close > bar.open) {
        return bar.close >= prev.high ? 'greenL3' : 'neutral';
    }
    // red
    return bar.close <= prev.low ? 'redL3' : 'neutral';
}

/** Exact time match, falling back to the last bar at or before `t`
 *  (defensive: hover always passes an on-chart bucket open). */
function findBarIndex(bars, t) {
    for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].time === t) return i;
        if (bars[i].time < t) return i;
    }
    return -1;
}

function clampWindow(n) {
    if (!Number.isFinite(n)) return DEFAULT_WINDOWS[0];
    return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round(n)));
}

export default TrendStatusEngine;
