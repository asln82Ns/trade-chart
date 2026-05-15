// metrics.js — derived performance metrics over a completed-trade log.
//
// A "trade" here is one closed (round-turn) position slice as recorded by
// TradeSimulator.completedTrades:
//   { direction, entryTime, entryPrice, exitTime, exitPrice, quantity, pnl,
//     timeframeMin, contract }
//
// All money figures are in account currency (dollars), matching `pnl`.
// The equity curve and drawdown analysis follow the order trades were CLOSED
// in the log (insertion order) — i.e. the order they actually happened during
// replay — not exit-timestamp order. (For a single play-through these are the
// same; if a session was re-played and trades accumulated, insertion order is
// the meaningful "performance over time" sequence.)

/** Downside deviation against a target (default 0): RMS of the negative
 *  deviations, divided by N (not N-1). This is the common convention for
 *  trade-level Sortino. */
function downsideDeviation(values, target = 0) {
    if (!values.length) return 0;
    let sumSq = 0;
    for (const v of values) {
        const d = v - target;
        if (d < 0) sumSq += d * d;
    }
    return Math.sqrt(sumSq / values.length);
}

/** Cumulative-P&L equity curve as lightweight-charts points.
 *  x = exitTime (unix sec), nudged to be strictly increasing so the chart
 *  accepts it even if two trades closed in the same second; y = running P&L.
 *  A leading {time, value:0} point anchors the curve at zero. */
export function equityCurve(trades) {
    if (!trades.length) return [];
    const firstEntry = trades.reduce(
        (m, t) => Math.min(m, Number.isFinite(t.entryTime) ? t.entryTime : Infinity),
        Infinity,
    );
    const anchorT = Number.isFinite(firstEntry) ? firstEntry : (trades[0].exitTime - 1);
    const pts = [{ time: anchorT, value: 0 }];
    let cum = 0;
    let lastT = anchorT;
    for (const t of trades) {
        cum += (t.pnl || 0);
        let x = Number.isFinite(t.exitTime) ? t.exitTime : (lastT + 1);
        if (x <= lastT) x = lastT + 1;
        lastT = x;
        pts.push({ time: x, value: Math.round(cum * 100) / 100 });
    }
    return pts;
}

/** Drawdown episodes over the realized-P&L curve (closed trades only),
 *  walked in trade-close order. An episode opens the first time equity dips
 *  below a running peak and closes when equity returns to (or above) that
 *  peak. `depth` = deepest dip in the episode; `trades` = closed trades it
 *  spanned (peak → recovery); `days` = market time between the peak trade's
 *  exit and the recovery trade's exit. A drawdown still open at the end of
 *  the log counts as an episode with open:true. */
function drawdownEpisodes(trades) {
    if (!trades.length) return [];
    // Equity AFTER each trade, with a synthetic "trade 0" at equity 0.
    const eq = [0];
    const ts = [Number.isFinite(trades[0].entryTime) ? trades[0].entryTime : trades[0].exitTime];
    let cum = 0;
    for (const t of trades) { cum += (t.pnl || 0); eq.push(cum); ts.push(t.exitTime); }

    const episodes = [];
    let peak = eq[0], peakIdx = 0, deepest = 0;
    for (let i = 1; i < eq.length; i++) {
        if (eq[i] >= peak) {
            if (deepest > 0) {
                episodes.push({
                    depth: deepest,
                    trades: i - peakIdx,
                    days: Math.max(0, ((ts[i] ?? ts[peakIdx]) - ts[peakIdx]) / 86400),
                    open: false,
                });
            }
            peak = eq[i]; peakIdx = i; deepest = 0;
        } else {
            const dip = peak - eq[i];
            if (dip > deepest) deepest = dip;
        }
    }
    if (deepest > 0) {
        const lastIdx = eq.length - 1;
        episodes.push({
            depth: deepest,
            trades: lastIdx - peakIdx,
            days: Math.max(0, ((ts[lastIdx] ?? ts[peakIdx]) - ts[peakIdx]) / 86400),
            open: true,
        });
    }
    return episodes;
}

/** Full metric bundle for a trade log. Safe on an empty array. */
export function computeMetrics(trades) {
    const n = trades.length;
    if (n === 0) {
        return {
            totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
            avgWin: 0, avgLoss: 0, avgPerTrade: 0, totalPnL: 0,
            sortino: null, maxDrawdown: 0, avgDrawdown: 0,
            longestDdTrades: 0, longestDdDays: 0, ddEpisodeCount: 0,
        };
    }
    const pnls = trades.map(t => t.pnl || 0);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const total = pnls.reduce((s, p) => s + p, 0);
    const mean = total / n;
    const dd = downsideDeviation(pnls, 0);
    const episodes = drawdownEpisodes(trades);
    return {
        totalTrades: n,
        winningTrades: wins.length,
        losingTrades: losses.length,
        winRate: (wins.length / n) * 100,
        avgWin: wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0,
        avgLoss: losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0,
        avgPerTrade: mean,
        totalPnL: total,
        sortino: dd > 0 ? mean / dd : null,
        maxDrawdown: episodes.reduce((m, e) => Math.max(m, e.depth), 0),
        avgDrawdown: episodes.length ? episodes.reduce((s, e) => s + e.depth, 0) / episodes.length : 0,
        longestDdTrades: episodes.reduce((m, e) => Math.max(m, e.trades), 0),
        longestDdDays: episodes.reduce((m, e) => Math.max(m, e.days), 0),
        ddEpisodeCount: episodes.length,
    };
}
