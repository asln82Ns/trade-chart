// GhostEngine — turns a /ghost server payload + the current real-bar set into
// an array of ghost-overlay bars.
//
// Two anchor modes:
//
//   session  (default)
//     • Bar 0 of each session anchors ghost.open to the real bar's actual
//       open at the 18:00 ET session start.
//     • Within a session, ghost.open chains from previous ghost's close so
//       drift accumulates.
//     • Forward ghosts (past the cursor) chain from the last computed
//       ghost's close. They cannot re-anchor mid-projection because no
//       real bar exists yet to anchor to.
//
//   realtime
//     • Each ghost.open = prior real bar's close. The forming bar's ghost
//       opens at realBars[N-2].close (the close of the bar BEFORE forming).
//       This is safe with respect to leakage: only already-played closes
//       are used.
//     • Forward ghosts chain from the cursor's current real close
//       (forming.close). That's why realtime mode requires a within-bar
//       recompute on every tick — forming.close moves continuously, so
//       forward ghosts shift in lockstep. Past ghosts stay locked because
//       their anchor (a prior bar's close) is permanent.
//
// Direction tallying ignores doji entirely (close == open). Doji bars
// contribute to the bucket's N total and to the volume distribution but
// are excluded from body/wick medians and from the % blue / % gray.
//
// Wicks (stratified by direction):
//   blue (close > open):  lower = open  - low,   upper = high - close
//   gray (close < open):  lower = close - low,   upper = high - open

import { formatEtHHMM } from './time-utils.js';

const DEFAULT_LOW_N_THRESHOLD = 5;
const DEFAULT_FORWARD_COUNT = 3;
// Cap forward attempts so we don't loop forever advancing past dead-time
// (e.g., the 1-hour CME session break) when no bucket data exists.
const MAX_FORWARD_ATTEMPTS = 24;

class GhostEngine {
    constructor() {
        this.data = null;
        this.lowNThreshold = DEFAULT_LOW_N_THRESHOLD;
        this.timeframeMin = 0;        // 0 = no forward projection
        this.forwardCount = DEFAULT_FORWARD_COUNT;
        this.mode = 'session';         // 'session' | 'realtime'
    }

    setData(data) { this.data = data || null; }
    clear() { this.data = null; }
    hasData() { return this.data !== null && !!this.data.buckets; }

    setTimeframeMin(tf) { this.timeframeMin = (tf > 0) ? tf : 0; }
    setForwardCount(n) { this.forwardCount = Math.max(0, n | 0); }
    setMode(mode) { this.mode = (mode === 'realtime') ? 'realtime' : 'session'; }

    /** Build a single ghost bar from a bucket lookup + an anchor price.
     *  Returns null if the bucket is missing or has too little data. */
    _buildGhost(time, bucket, anchorPrice) {
        if (!bucket) return null;
        const nTotal = (bucket.n_blue || 0) + (bucket.n_gray || 0) + (bucket.n_doji || 0);
        if (nTotal < this.lowNThreshold) return null;
        // Direction: strict blue vs strict gray; doji excluded.
        const isBlue = (bucket.n_blue || 0) > (bucket.n_gray || 0);
        const body = isBlue ? (bucket.body_blue || 0) : (bucket.body_gray || 0);
        const lwick = isBlue ? (bucket.lwick_blue || 0) : (bucket.lwick_gray || 0);
        const uwick = isBlue ? (bucket.uwick_blue || 0) : (bucket.uwick_gray || 0);
        let ghost;
        if (isBlue) {
            const close = anchorPrice + body;
            ghost = {
                time,
                open: anchorPrice,
                close,
                low: anchorPrice - lwick,
                high: close + uwick,
            };
        } else {
            // Nudge close fractionally below anchor when body == 0 so the
            // candle still renders bearish; tiny epsilon avoids zero-height.
            const close = body > 0 ? anchorPrice - body : anchorPrice;
            ghost = {
                time,
                open: anchorPrice,
                close,
                low: close - lwick,
                high: anchorPrice + uwick,
            };
        }
        ghost.volume = bucket.volume || 0;
        ghost.color = isBlue ? 'blue' : 'gray';
        ghost.n = nTotal;
        const nDirected = (bucket.n_blue || 0) + (bucket.n_gray || 0);
        ghost.pctBlue = nDirected > 0 ? (bucket.n_blue / nDirected) : 0;
        ghost.pctGray = nDirected > 0 ? (bucket.n_gray / nDirected) : 0;
        return ghost;
    }

    /**
     * @param {Array} realBars - [{time, open, high, low, close, volume}, ...] sorted by time
     * @returns {Array} ghost bars [{time, open, high, low, close, volume, color, n, pctBlue, pctGray, forward?}]
     */
    computeOverlay(realBars) {
        if (!this.hasData() || !realBars || !realBars.length) return [];
        const buckets = this.data.buckets;
        const out = [];
        let prevGhost = null;

        // ---- Real bars ----
        for (let i = 0; i < realBars.length; i++) {
            const bar = realBars[i];
            const hhmm = formatEtHHMM(bar.time);
            const bucket = buckets[hhmm];

            // Anchor selection.
            let anchor;
            if (this.mode === 'realtime') {
                // Past + current: anchor on prior real close. First bar
                // has no prior — fall back to its own open.
                anchor = (i > 0) ? realBars[i - 1].close : bar.open;
            } else {
                // Session anchor: re-anchor at 18:00 ET or after a gap.
                const isSessionOpen = (hhmm === '18:00');
                anchor = (isSessionOpen || !prevGhost) ? bar.open
                                                       : prevGhost.close;
            }

            const ghost = this._buildGhost(bar.time, bucket, anchor);
            if (!ghost) {
                prevGhost = null;
                continue;
            }
            out.push(ghost);
            prevGhost = ghost;
        }

        // ---- Forward projection (past the cursor) ----
        if (this.timeframeMin > 0 && this.forwardCount > 0 && realBars.length > 0) {
            const tfSec = this.timeframeMin * 60;
            const lastReal = realBars[realBars.length - 1];

            // Anchor seed for forward chain depends on mode:
            //   session  → last computed ghost's close (prevGhost). If no
            //              ghost was emitted (gap at end), skip forward.
            //   realtime → forming bar's current close — that's the
            //              cursor's "now" close, which is allowed to
            //              influence ghosts (no future-leak; it's already
            //              played by definition).
            let chainAnchor;
            if (this.mode === 'realtime') {
                chainAnchor = lastReal.close;
            } else {
                if (!prevGhost) return out;
                chainAnchor = prevGhost.close;
            }

            let nextTime = lastReal.time + tfSec;
            let emitted = 0;
            let attempts = 0;
            while (emitted < this.forwardCount && attempts < MAX_FORWARD_ATTEMPTS) {
                attempts++;
                const hhmm = formatEtHHMM(nextTime);
                const bucket = buckets[hhmm];
                const ghost = this._buildGhost(nextTime, bucket, chainAnchor);
                if (ghost) {
                    ghost.forward = true;
                    out.push(ghost);
                    chainAnchor = ghost.close;
                    emitted++;
                }
                // Advance the time even on skip, so dead-time (no bucket)
                // gets walked past rather than infinite-looped.
                nextTime += tfSec;
            }
        }

        return out;
    }
}

export default GhostEngine;
