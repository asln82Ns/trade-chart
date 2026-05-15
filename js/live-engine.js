// LiveEngine — owns the chart in Live mode.
//
// Receives:
//   • A prime payload (last N sessions of spliced 1s bars) that paints the
//     historical context.
//   • A stream of {bar, final} updates from the server's WebSocket. `final`
//     means the 1s bar closed; otherwise it's the in-progress bar for the
//     current second.
//
// Maintains:
//   • this.tape  — finalized 1s bars (history + new finals)
//   • this.currentSecondBar — the in-progress 1s bar (replaced each tick)
//   • this.formingBar — the current timeframe bar, recomputed on every update
//
// The forming-timeframe bar is recomputed by walking back through `tape`
// while .t >= bucketStart, then folding in the in-progress bar. Cheap (≤300
// entries for a 5m timeframe) and avoids any subtraction bookkeeping.

import { floorToTimeframe } from './time-utils.js';

class LiveEngine {
    constructor(chartController, tradeSimulator = null) {
        this.chart = chartController;
        this.tradeSimulator = tradeSimulator;
        this.tape = [];
        this.currentSecondBar = null;
        this.timeframeMin = 5;
        this.rolls = [];
        this.sessions = new Map();
        this.formingBar = null;
        this.lastTickT = null;
        this._sessionOrder = [];
        this.onTickCallback = null;
        this.connected = false;
        // Set when an onLiveBar push lands an entry whose t is less than
        // the tape's prior tail. Triggers a single sort+dedupe before the
        // next tape read (in _updateForming or _renderHistory). Lazy so
        // we don't pay O(n log n) per bar during a flush burst — only
        // once when a forward bar arrives or the user changes timeframe.
        this._tapeNeedsSort = false;
    }

    setTradeSimulator(simulator) { this.tradeSimulator = simulator; }

    /** Initialize from server prime payload (same shape as /load response). */
    loadPrime({ bars, rolls, sessions, timeframeMin }) {
        this.tape = (bars || []).map(b => ({
            t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, s: b.s, k: b.k,
        })).sort((a, b) => a.t - b.t);
        this._tapeNeedsSort = false;
        this.currentSecondBar = null;
        this.timeframeMin = timeframeMin;
        this.rolls = (rolls || []).map(r => ({
            time: r.t,
            fromContract: r.from_contract,
            toContract: r.to_contract,
            spread: r.spread_translated || r.spread_raw || 0,
            incomplete: !!r.incomplete,
        }));
        this.sessions.clear();
        for (const s of (sessions || [])) {
            this.sessions.set(s.session_date, {
                bar_count: s.bar_count, contract: s.active_contract, open_t: s.open_t,
            });
        }
        this._reindexSessions();
        this._renderHistory();
        this._pushSessionOpens();
        this.lastTickT = this.tape.length ? this.tape[this.tape.length - 1].t : null;
    }

    /** Switch timeframe — re-aggregate the entire tape. */
    setTimeframe(minutes) {
        if (minutes === this.timeframeMin) return;
        this.timeframeMin = minutes;
        this._renderHistory();
        this._updateForming();
    }

    /** Process one bar message from the live websocket. */
    onLiveBar(bar, final) {
        const incoming = {
            t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v || 0,
            s: bar.s, k: bar.k,
        };
        // Skip "forward-time" rerender for older bars. Server's bar_history
        // flush replays bars from today_midnight_utc on subscribe; the first
        // batch is older than the prime's last entry. Updating chart series
        // backwards in time triggers lightweight-charts "Value is null"
        // throws and the cascading aggregate corruption that blanks the
        // chart on timeframe switch.
        let outOfOrder = false;
        if (final) {
            const n = this.tape.length;
            if (n === 0 || this.tape[n - 1].t < incoming.t) {
                this.tape.push(incoming);
            } else if (this.tape[n - 1].t === incoming.t) {
                this.tape[n - 1] = incoming;
            } else {
                // Older than the tape's tail — gap-fill or duplicate from
                // bar_history. Append and defer sort+dedupe to the next
                // tape read; don't drop because some of these may be
                // genuine gap-fills between prime end and live now (e.g.,
                // when prime is cached from earlier in the day).
                this.tape.push(incoming);
                this._tapeNeedsSort = true;
                outOfOrder = true;
            }
            if (this.currentSecondBar && this.currentSecondBar.t === incoming.t) {
                this.currentSecondBar = null;
            }
            // Track new sessions appearing in the live tape.
            if (incoming.s && !this.sessions.has(incoming.s)) {
                this.sessions.set(incoming.s, { bar_count: 1, contract: incoming.k, open_t: null });
                this._reindexSessions();
            }
        } else {
            // In-progress bars must be at or after the most recent finalized
            // tick. A stale in-progress (rare; e.g., late-arriving message
            // from a prior subscription that slipped past the asset filter)
            // would otherwise drag the forming bar backwards.
            if (this.tape.length && this.tape[this.tape.length - 1].t > incoming.t) {
                return;
            }
            this.currentSecondBar = incoming;
        }
        if (outOfOrder) {
            // Older bar — record it but don't pretend "now" went backwards.
            // The simulator and onTick observers should only react to
            // forward-moving ticks. The next forward bar will trigger the
            // lazy normalize and a clean forming-bar render.
            return;
        }
        this.lastTickT = incoming.t;
        this._updateForming();
        if (this.tradeSimulator) {
            this.tradeSimulator.processSecond({
                t: incoming.t,
                price: incoming.c,
                high: incoming.h,
                low: incoming.l,
                volume: incoming.v,
                k: incoming.k,
            });
        }
        if (this.onTickCallback) {
            this.onTickCallback({
                tick: incoming,
                formingBar: this.formingBar,
                final,
            });
        }
    }

    /** Sort + dedupe the tape by t. Called lazily before any read that
     *  depends on the sort invariant. No-op when the flag is clear. */
    _normalizeTape() {
        if (!this._tapeNeedsSort) return;
        this.tape.sort((a, b) => a.t - b.t);
        // In-place dedupe by t, keeping the latest entry encountered.
        let w = 0;
        for (let r = 0; r < this.tape.length; r++) {
            if (w > 0 && this.tape[w - 1].t === this.tape[r].t) {
                this.tape[w - 1] = this.tape[r];
            } else {
                this.tape[w++] = this.tape[r];
            }
        }
        this.tape.length = w;
        this._tapeNeedsSort = false;
    }

    _updateForming() {
        this._normalizeTape();
        const refT = this.currentSecondBar
            ? this.currentSecondBar.t
            : (this.tape.length ? this.tape[this.tape.length - 1].t : null);
        if (refT === null) { this.formingBar = null; return; }
        const bucketTime = floorToTimeframe(refT, this.timeframeMin);
        const bucketEnd = bucketTime + this.timeframeMin * 60;
        let i = this.tape.length - 1;
        while (i >= 0 && this.tape[i].t >= bucketTime) i--;
        const slice = this.tape.slice(i + 1);
        if (this.currentSecondBar &&
            this.currentSecondBar.t >= bucketTime &&
            this.currentSecondBar.t < bucketEnd) {
            slice.push(this.currentSecondBar);
        }
        if (!slice.length) { this.formingBar = null; return; }
        const first = slice[0];
        const bar = {
            time: bucketTime,
            open: first.o, high: first.h, low: first.l, close: first.c,
            volume: first.v, contract: first.k, sessionDate: first.s,
        };
        for (let j = 1; j < slice.length; j++) {
            const t = slice[j];
            if (t.h > bar.high) bar.high = t.h;
            if (t.l < bar.low) bar.low = t.l;
            bar.close = t.c;
            bar.volume += t.v;
            bar.contract = t.k;
            bar.sessionDate = t.s;
        }
        this.formingBar = bar;
        // Defense in depth: lightweight-charts throws on update-with-older-time
        // and there's no public way to query its current last-bar time. If a
        // race or unknown edge case still produces a backwards update, log
        // and keep the engine functional rather than letting an uncaught
        // throw propagate up the websocket message handler.
        try {
            this.chart.updateBar(bar);
        } catch (e) {
            console.warn('chart.updateBar threw, skipping this paint:', e?.message || e);
        }
    }

    _renderHistory() {
        this._normalizeTape();
        const aggregated = this._aggregate(this.tape, this.timeframeMin);
        try {
            this.chart.setData(aggregated, this.rolls);
        } catch (e) {
            console.warn('chart.setData threw on _renderHistory, skipping:', e?.message || e);
            return;
        }
        if (aggregated.length > 0) {
            const lastIdx = aggregated.length - 1;
            const startIdx = Math.max(0, lastIdx - 200);
            this.chart.setVisibleRange(
                aggregated[startIdx].time,
                aggregated[lastIdx].time + this.timeframeMin * 60,
            );
        }
        this.formingBar = aggregated.length ? { ...aggregated[aggregated.length - 1] } : null;
    }

    _aggregate(slice, timeframeMin) {
        const out = [];
        let cur = null;
        for (const t of slice) {
            const bucket = floorToTimeframe(t.t, timeframeMin);
            if (!cur || cur.time !== bucket) {
                if (cur) out.push(cur);
                cur = {
                    time: bucket, open: t.o, high: t.h, low: t.l, close: t.c,
                    volume: t.v, contract: t.k, sessionDate: t.s,
                };
            } else {
                if (t.h > cur.high) cur.high = t.h;
                if (t.l < cur.low) cur.low = t.l;
                cur.close = t.c;
                cur.volume += t.v;
                cur.contract = t.k;
                cur.sessionDate = t.s;
            }
        }
        if (cur) out.push(cur);
        return out;
    }

    _reindexSessions() {
        const order = [];
        let last = null;
        for (let i = 0; i < this.tape.length; i++) {
            const s = this.tape[i].s;
            if (s !== last) { order.push(s); last = s; }
        }
        this._sessionOrder = order;
    }

    _pushSessionOpens() {
        const opens = [];
        for (const meta of this.sessions.values()) {
            if (typeof meta.open_t === 'number') opens.push(meta.open_t);
        }
        if (this.chart.setSessionOpens) this.chart.setSessionOpens(opens);
    }

    onTick(cb) { this.onTickCallback = cb; }

    /** For the trade simulator's "last tick" lookup. */
    getCurrentTick() {
        if (this.currentSecondBar) return this.currentSecondBar;
        if (this.tape.length) return this.tape[this.tape.length - 1];
        return null;
    }

    /** Reported as "playing" iff the WS feed is connected. Hover handler uses this. */
    getCurrentState() {
        return {
            isPlaying: false,  // hover stays interactive in live mode
            connected: this.connected,
            formingBar: this.formingBar,
            timeframeMin: this.timeframeMin,
        };
    }

    getLoadedSessionCount() { return this._sessionOrder.length; }

    clearAll() {
        this.tape = [];
        this._tapeNeedsSort = false;
        this.currentSecondBar = null;
        this.formingBar = null;
        this.rolls = [];
        this.sessions.clear();
        this._sessionOrder = [];
        this.lastTickT = null;
        this.connected = false;
        if (this.chart.clear) this.chart.clear();
    }
}

export default LiveEngine;
