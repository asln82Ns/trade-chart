// PlaybackEngine — drives 1s tape playback while aggregating to user timeframe.
//
// Responsibilities:
//   • Hold the spliced 1s tape (sliding window of N sessions).
//   • Aggregate the tape into the user-selected timeframe for both the
//     historical context window and the live forming bar.
//   • Tick rate = "ticks/sec" where 1 tick = 1 second of market time.
//   • Trigger an async prefetch when playback head crosses 80% of loaded data.
//   • Evict oldest sessions when memory exceeds the cap.
//
// Bar shape from server (/load):
//   {t: unix_sec, o, h, l, c, v, s: "YYYY-MM-DD" sessionDate, k: "raw_symbol" contract}

import { floorToTimeframe } from './time-utils.js';

const DEFAULT_PREFETCH_AT = 0.8;        // trigger prefetch when 80% through loaded forward data
const DEFAULT_MAX_SESSIONS = 30;        // soft cap on sessions held in memory

class PlaybackEngine {
    constructor(chartController, tradeSimulator = null) {
        this.chart = chartController;
        this.tradeSimulator = tradeSimulator;

        // Loaded tape, sorted by time.
        this.tape = [];                  // 1s bars: {t, o, h, l, c, v, s, k}
        this.tapeIndex = 0;              // next 1s bar to consume during replay
        this.contextEndIndex = 0;        // tape index where replay starts (entry boundary, snapped to bucket)
        this.entryUserUnix = null;       // user's chosen entry instant (un-snapped)
        this.entryUnix = null;           // entry instant snapped to current timeframe bucket
        this.timeframeMin = 5;
        this.sessions = new Map();       // sessionDate -> {firstTapeIdx, lastTapeIdx, bars: count}
        this.rolls = [];                 // [{time, fromContract, toContract, spread, incomplete}]
        this.maxSessions = DEFAULT_MAX_SESSIONS;
        this.prefetchAt = DEFAULT_PREFETCH_AT;

        // Aggregation state for the bar currently being built during replay.
        this.formingBar = null;          // {time, open, high, low, close, volume, contract, sessionDate}

        // Playback state.
        this.isPlaying = false;
        this.ticksPerSecond = 60;        // 60 = roughly real-time at 1s tape (1 sec market / 1 sec wall)
        this.lastFrameTime = 0;
        this.tickAccumulator = 0;
        this.animationFrameId = null;

        this.onTickCallback = null;
        this.onPrefetchNeededCallback = null;  // (lastLoadedSession) => void
        this.onPlaybackEndCallback = null;
        this.onSessionEvictedCallback = null;

        this.prefetchInFlight = false;
    }

    // -------- Loading -------- //

    /** Replace the tape with an initial load. */
    loadInitial({ bars, rolls, sessions, entryUnix, timeframeMin }) {
        this.tape = bars.map(b => ({
            t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, s: b.s, k: b.k,
        })).sort((a, b) => a.t - b.t);

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
                bar_count: s.bar_count,
                contract: s.active_contract,
                open_t: s.open_t,
            });
        }
        this._reindexSessions();
        this._pushSessionOpens();

        this.entryUserUnix = entryUnix;
        this.timeframeMin = timeframeMin;
        // Snap to the start of the bucket containing entry so the first replay
        // bar builds cleanly from open instead of overwriting partial context.
        this.entryUnix = floorToTimeframe(entryUnix, timeframeMin);
        this.contextEndIndex = this._lowerBound(this.entryUnix);
        this.tapeIndex = this.contextEndIndex;
        this.formingBar = null;

        this._renderContext();
    }

    /** Append more bars (forward prefetch). */
    appendBars({ bars, rolls, sessions }) {
        if (!bars || bars.length === 0) return;
        const lastT = this.tape.length ? this.tape[this.tape.length - 1].t : -Infinity;
        let added = 0;
        for (const b of bars) {
            if (b.t <= lastT) continue;  // skip overlap
            this.tape.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, s: b.s, k: b.k });
            added++;
        }
        if (rolls) {
            for (const r of rolls) {
                if (this.rolls.some(x => x.time === r.t)) continue;
                this.rolls.push({
                    time: r.t,
                    fromContract: r.from_contract,
                    toContract: r.to_contract,
                    spread: r.spread_translated || r.spread_raw || 0,
                    incomplete: !!r.incomplete,
                });
            }
            this.rolls.sort((a, b) => a.time - b.time);
        }
        if (sessions) {
            for (const s of sessions) {
                this.sessions.set(s.session_date, {
                    bar_count: s.bar_count,
                    contract: s.active_contract,
                    open_t: s.open_t,
                });
            }
        }
        this._reindexSessions();
        this._evictIfNeeded();
        this.chart.setMarkers(this.rolls);
        this._pushSessionOpens();
        return added;
    }

    _pushSessionOpens() {
        const opens = [];
        for (const meta of this.sessions.values()) {
            if (typeof meta.open_t === 'number') opens.push(meta.open_t);
        }
        if (this.chart.setSessionOpens) this.chart.setSessionOpens(opens);
    }

    /** Re-aggregate everything seen so far at the new timeframe and re-render. */
    setTimeframe(minutes) {
        if (minutes === this.timeframeMin) return;
        this.timeframeMin = minutes;
        if (this.entryUserUnix !== null) {
            this.entryUnix = floorToTimeframe(this.entryUserUnix, minutes);
            this.contextEndIndex = this._lowerBound(this.entryUnix);
            if (this.tapeIndex < this.contextEndIndex) this.tapeIndex = this.contextEndIndex;
        }
        // Re-aggregate the entire played-through tape (context + already-played).
        const playedSlice = this.tape.slice(0, this.tapeIndex);
        const aggregated = this._aggregate(playedSlice, this.timeframeMin);
        this.chart.setData(aggregated, this.rolls);
        this.formingBar = aggregated.length ? { ...aggregated[aggregated.length - 1] } : null;
        if (aggregated.length > 0) {
            const lastIdx = aggregated.length - 1;
            const startIdx = Math.max(0, lastIdx - 200);
            this.chart.setVisibleRange(aggregated[startIdx].time, aggregated[lastIdx].time + this.timeframeMin * 60);
        }
    }

    // -------- Playback -------- //

    setSpeed(ticksPerSecond) {
        this.ticksPerSecond = Math.max(1, Math.min(5000, ticksPerSecond));
    }

    play() {
        if (this.isPlaying) return;
        if (this.tapeIndex >= this.tape.length) return;
        this.isPlaying = true;
        this.lastFrameTime = performance.now();
        this.tickAccumulator = 0;
        this._animate();
    }

    pause() {
        this.isPlaying = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    reset() {
        this.pause();
        this.tapeIndex = this.contextEndIndex;
        this.formingBar = null;
        this._renderContext();
    }

    /** Fast-forward playback to the first tape tick at or after targetT, rebuilding
     *  the forming bar from the bucket containing the destination. Used by Resume
     *  to land at the user's last-viewed tick after loadInitial — no per-tick
     *  rendering and the simulator is NOT ticked during the seek, so trades
     *  restored via TradeSimulator.restoreTrades stay intact. Safe no-op if
     *  targetT is at/before entryUnix or already past tapeIndex. */
    seekTo(targetT) {
        if (!Number.isFinite(targetT)) return;
        if (this.tape.length === 0) return;
        const idx = Math.min(this._lowerBound(targetT), this.tape.length);
        if (idx <= this.contextEndIndex) return;
        if (idx <= this.tapeIndex) return;
        this.tapeIndex = idx;

        const lastTick = this.tape[this.tapeIndex - 1];
        const bucketTime = floorToTimeframe(lastTick.t, this.timeframeMin);
        let bucketStartIdx = this._lowerBound(bucketTime);
        if (bucketStartIdx < this.contextEndIndex) bucketStartIdx = this.contextEndIndex;
        let fb = null;
        for (let i = bucketStartIdx; i < this.tapeIndex; i++) {
            const tk = this.tape[i];
            if (!fb) {
                fb = { time: bucketTime, open: tk.o, high: tk.h, low: tk.l, close: tk.c, volume: tk.v, contract: tk.k, sessionDate: tk.s };
            } else {
                fb.high = Math.max(fb.high, tk.h);
                fb.low = Math.min(fb.low, tk.l);
                fb.close = tk.c;
                fb.volume += tk.v;
                fb.contract = tk.k;
                fb.sessionDate = tk.s;
            }
        }
        this.formingBar = fb;

        const playedSlice = this.tape.slice(0, this.tapeIndex);
        const aggregated = this._aggregate(playedSlice, this.timeframeMin);
        this.chart.setData(aggregated, this.rolls);
        if (aggregated.length > 0) {
            const lastIdx = aggregated.length - 1;
            const startIdx = Math.max(0, lastIdx - 200);
            this.chart.setVisibleRange(aggregated[startIdx].time, aggregated[lastIdx].time + this.timeframeMin * 60);
        }

        // Emit a single onTick callback so the info panels (Time, OHLC, ranks,
        // contract, tapePos) update to the destination immediately — otherwise
        // they sit at "--" until the user clicks Play and the first real tick
        // fires.
        if (this.onTickCallback) {
            this.onTickCallback({
                tick: lastTick,
                formingBar: this.formingBar,
                tapeIndex: this.tapeIndex,
                tapeLength: this.tape.length,
            });
        }
    }

    _animate() {
        if (!this.isPlaying) return;
        const now = performance.now();
        const delta = (now - this.lastFrameTime) / 1000;
        this.lastFrameTime = now;
        this.tickAccumulator += delta * this.ticksPerSecond;
        const ticks = Math.floor(this.tickAccumulator);
        this.tickAccumulator -= ticks;

        for (let i = 0; i < ticks; i++) {
            if (!this._processTick()) {
                this.pause();
                if (this.onPlaybackEndCallback) this.onPlaybackEndCallback();
                return;
            }
        }
        this._maybePrefetch();
        this.animationFrameId = requestAnimationFrame(() => this._animate());
    }

    _processTick() {
        if (this.tapeIndex >= this.tape.length) return false;
        const tick = this.tape[this.tapeIndex++];

        // Find the timeframe bucket for this tick.
        const bucketTime = floorToTimeframe(tick.t, this.timeframeMin);
        if (!this.formingBar || this.formingBar.time !== bucketTime) {
            this.formingBar = {
                time: bucketTime,
                open: tick.o,
                high: tick.h,
                low: tick.l,
                close: tick.c,
                volume: tick.v,
                contract: tick.k,
                sessionDate: tick.s,
            };
        } else {
            this.formingBar.high = Math.max(this.formingBar.high, tick.h);
            this.formingBar.low = Math.min(this.formingBar.low, tick.l);
            this.formingBar.close = tick.c;
            this.formingBar.volume += tick.v;
            this.formingBar.contract = tick.k;
            this.formingBar.sessionDate = tick.s;
        }
        this.chart.updateBar(this.formingBar);

        if (this.tradeSimulator) {
            this.tradeSimulator.processSecond({
                t: tick.t,
                price: tick.c,
                high: tick.h,
                low: tick.l,
                volume: tick.v,
                k: tick.k,
            });
        }

        if (this.onTickCallback) {
            this.onTickCallback({
                tick,
                formingBar: this.formingBar,
                tapeIndex: this.tapeIndex,
                tapeLength: this.tape.length,
            });
        }
        return true;
    }

    _maybePrefetch() {
        if (this.prefetchInFlight) return;
        if (!this.onPrefetchNeededCallback) return;
        const totalForward = this.tape.length - this.contextEndIndex;
        if (totalForward <= 0) return;
        const consumed = this.tapeIndex - this.contextEndIndex;
        if (consumed / totalForward >= this.prefetchAt) {
            this.prefetchInFlight = true;
            const lastSession = this.tape.length ? this.tape[this.tape.length - 1].s : null;
            Promise.resolve(this.onPrefetchNeededCallback(lastSession))
                .finally(() => { this.prefetchInFlight = false; });
        }
    }

    // -------- Aggregation for context -------- //

    _renderContext() {
        const contextSlice = this.tape.slice(0, this.contextEndIndex);
        const aggregated = this._aggregate(contextSlice, this.timeframeMin);
        const renderable = aggregated.map(b => ({
            time: b.time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            contract: b.contract,
            sessionDate: b.sessionDate,
        }));
        this.chart.setData(renderable, this.rolls);
        if (renderable.length > 0) {
            const lastIdx = renderable.length - 1;
            const startIdx = Math.max(0, lastIdx - 200);
            this.chart.setVisibleRange(renderable[startIdx].time, renderable[lastIdx].time + this.timeframeMin * 60);
        }
    }

    _aggregate(slice, timeframeMin) {
        const out = [];
        let cur = null;
        for (const t of slice) {
            const bucket = floorToTimeframe(t.t, timeframeMin);
            if (!cur || cur.time !== bucket) {
                if (cur) out.push(cur);
                cur = {
                    time: bucket,
                    open: t.o,
                    high: t.h,
                    low: t.l,
                    close: t.c,
                    volume: t.v,
                    contract: t.k,
                    sessionDate: t.s,
                };
            } else {
                cur.high = Math.max(cur.high, t.h);
                cur.low = Math.min(cur.low, t.l);
                cur.close = t.c;
                cur.volume += t.v;
                cur.contract = t.k;
                cur.sessionDate = t.s;
            }
        }
        if (cur) out.push(cur);
        return out;
    }

    // -------- Session bookkeeping & eviction -------- //

    _reindexSessions() {
        const order = [];
        let lastSession = null;
        for (let i = 0; i < this.tape.length; i++) {
            const s = this.tape[i].s;
            if (s !== lastSession) {
                order.push(s);
                lastSession = s;
            }
        }
        this._sessionOrder = order;
    }

    _evictIfNeeded() {
        if (!this._sessionOrder || this._sessionOrder.length <= this.maxSessions) return;
        // Drop oldest sessions until under cap, but never drop a session containing
        // the playback head or the entry session (preserve continuity).
        const entrySession = this.tape[this.contextEndIndex]?.s;
        const playSession = this.tape[Math.min(this.tapeIndex, this.tape.length - 1)]?.s;
        const targetDrop = this._sessionOrder.length - this.maxSessions;
        let dropped = 0;
        while (dropped < targetDrop && this._sessionOrder.length > 0) {
            const oldest = this._sessionOrder[0];
            if (oldest === entrySession || oldest === playSession) break;
            // Find first index where session > oldest.
            let firstKept = 0;
            while (firstKept < this.tape.length && this.tape[firstKept].s === oldest) firstKept++;
            if (firstKept === 0) break;
            this.tape.splice(0, firstKept);
            this.contextEndIndex = Math.max(0, this.contextEndIndex - firstKept);
            this.tapeIndex = Math.max(0, this.tapeIndex - firstKept);
            this._sessionOrder.shift();
            this.sessions.delete(oldest);
            dropped++;
            if (this.onSessionEvictedCallback) this.onSessionEvictedCallback(oldest);
        }
    }

    // -------- Helpers -------- //

    _lowerBound(unix) {
        let lo = 0, hi = this.tape.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.tape[mid].t < unix) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    onTick(cb) { this.onTickCallback = cb; }
    onPrefetchNeeded(cb) { this.onPrefetchNeededCallback = cb; }
    onPlaybackEnd(cb) { this.onPlaybackEndCallback = cb; }
    onSessionEvicted(cb) { this.onSessionEvictedCallback = cb; }

    getCurrentState() {
        return {
            isPlaying: this.isPlaying,
            tapeIndex: this.tapeIndex,
            tapeLength: this.tape.length,
            contextEndIndex: this.contextEndIndex,
            formingBar: this.formingBar,
            timeframeMin: this.timeframeMin,
        };
    }

    getCurrentTick() {
        if (this.tapeIndex === 0) return null;
        return this.tape[this.tapeIndex - 1];
    }

    getLoadedSessionCount() {
        return this._sessionOrder ? this._sessionOrder.length : 0;
    }

    getLastLoadedSession() {
        if (!this._sessionOrder || this._sessionOrder.length === 0) return null;
        return this._sessionOrder[this._sessionOrder.length - 1];
    }
}

export default PlaybackEngine;
