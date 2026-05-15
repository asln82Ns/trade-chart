// Rank engine: computes percentile-rank metrics for a (live or historical) bar
// against the same time-of-day bucket from the loaded /ranks data.
//
// Inputs per call:
//   bar.time           = bucket open (unix sec) — same key the server bucketed by
//   bar.volume         = current cumulative volume in the bar (or final, if done)
//   bar.high, bar.low  = current cumulative range extremes
//   currentTickT       = unix sec of the most recent 1s tick (for elapsed)
//
// Outputs:
//   { volRank, volPendingRank, rangeRank, rangePendingRank,
//     n, lowN: bool, elapsedFraction, formula }
//
// Estimator: empirical fractional profile + 10% early-window shrinkage clamp.
//   estimate = current / f(p)                   if p >= 0.10
//   estimate = α (current / f(p)) + (1-α) median  if p < 0.10, α = p / 0.10
// Capped to a numerically safe f(p) > 0.001; falls back to median otherwise.

import { formatEtHHMM } from './time-utils.js';

class RankEngine {
    constructor() {
        this.data = null;          // /ranks response
        this.timeframeMin = null;
        this.lowNThreshold = 20;
    }

    setData(data) {
        this.data = data;
        this.timeframeMin = data?.timeframe_min ?? null;
        this.lowNThreshold = data?.low_n_threshold ?? 20;
    }

    clear() {
        this.data = null;
        this.timeframeMin = null;
    }

    hasData() { return !!this.data && !!this.data.buckets; }

    /** Compute ranks for a bar. currentTickT may be null (treats bar as fully formed). */
    forBar(bar, currentTickT) {
        if (!this.hasData() || !bar) return null;
        const bucketKey = formatEtHHMM(bar.time);
        const bucket = this.data.buckets[bucketKey];
        if (!bucket) {
            return { bucketKey, lowN: true, n: 0, missing: true };
        }
        const n = bucket.n | 0;
        const barDur = (this.timeframeMin || 1) * 60;
        // currentTickT < bar.time can occur on hover-before-replay; clamp to 0.
        // currentTickT > bar.time + barDur means historical bar; clamp to barDur.
        let elapsed;
        if (currentTickT == null) {
            elapsed = barDur;
        } else {
            elapsed = Math.max(0, Math.min(barDur, currentTickT - bar.time));
        }
        const p = elapsed / barDur;

        const currentVol = bar.volume || 0;
        const currentRange = (bar.high - bar.low) || 0;

        const result = {
            bucketKey, n, lowN: n < this.lowNThreshold, missing: false,
            elapsedFraction: p,
        };

        if (n === 0) {
            return result;
        }

        result.volRank = this._rank(bucket.volumes, currentVol);
        result.volRankIdx = this._rankIdx(bucket.volumes, currentVol);
        result.rangeRank = this._rank(bucket.ranges, currentRange);
        result.rangeRankIdx = this._rankIdx(bucket.ranges, currentRange);

        const medianVol = this._median(bucket.volumes);
        const medianRange = this._median(bucket.ranges);

        const estVol = this._estimate(currentVol, p, bucket.vol_profile, medianVol);
        const estRange = this._estimate(currentRange, p, bucket.range_profile, medianRange);
        result.volPendingRank = this._rank(bucket.volumes, estVol);
        result.volPendingRankIdx = this._rankIdx(bucket.volumes, estVol);
        result.rangePendingRank = this._rank(bucket.ranges, estRange);
        result.rangePendingRankIdx = this._rankIdx(bucket.ranges, estRange);
        result.estVol = estVol;
        result.estRange = estRange;
        return result;
    }

    /** Absolute rank in descending order (1 = largest). Ties get best rank. */
    _rankIdx(sorted, value) {
        const len = sorted.length;
        if (len === 0) return null;
        // bisect_right: count of values <= value
        let lo = 0, hi = len;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] <= value) lo = mid + 1;
            else hi = mid;
        }
        return (len - lo) + 1;
    }

    /** Percentile rank (0..100) of value in a sorted ascending array. */
    _rank(sorted, value) {
        const len = sorted.length;
        if (len === 0) return null;
        // bisect_right gives strict-less-than position; using midpoint of tie band:
        let lo = 0, hi = len;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] <= value) lo = mid + 1;
            else hi = mid;
        }
        return (lo / len) * 100;
    }

    _median(sorted) {
        const len = sorted.length;
        if (len === 0) return 0;
        const mid = len >> 1;
        if (len % 2 === 1) return sorted[mid];
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }

    _estimate(current, p, profile, median) {
        if (!profile || profile.length < 2) return current;
        if (p <= 0) return median;
        if (p >= 1) return current;

        const last = profile.length - 1;        // 60
        const idxF = p * last;
        const idxLo = Math.floor(idxF);
        const idxHi = Math.min(idxLo + 1, last);
        const w = idxF - idxLo;
        const f = profile[idxLo] * (1 - w) + profile[idxHi] * w;

        if (f <= 0.001) return median;
        let estimate = current / f;
        if (p < 0.10) {
            const alpha = p / 0.10;
            estimate = alpha * estimate + (1 - alpha) * median;
        }
        return estimate;
    }
}

export default RankEngine;
