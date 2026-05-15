// replay-store.js — localStorage persistence for replay sessions.
//
// A replay session is keyed by (asset, entryDate) — the trading scenario you
// were replaying. It records the cumulative completed-trade log plus a little
// metadata (when the session was first started, the last tick datetime you
// viewed, the timeframe at last save). Returning to the same asset + entry
// date in a future browser session lets you pick up where you left off.
//
// Everything is best-effort: localStorage may be unavailable (private mode,
// disabled) or full — callers get null / false rather than exceptions.

const PREFIX = 'tradeChart.replaySession.';
const VERSION = 1;

function keyFor(asset, entryDate) {
    return `${PREFIX}${asset}|${entryDate}`;
}

function safeStorage() {
    try {
        const s = window.localStorage;
        const probe = '__tc_probe__';
        s.setItem(probe, '1');
        s.removeItem(probe);
        return s;
    } catch (_) {
        return null;
    }
}

/** Persist (overwrite) the session for (asset, entryDate).
 *  `session`: { startedAt, lastViewedT, lastTimeframeMin, trades }.
 *  Returns true on success. */
export function saveSession(asset, entryDate, session) {
    if (!asset || !entryDate) return false;
    const s = safeStorage();
    if (!s) return false;
    const payload = {
        v: VERSION,
        asset,
        entryDate,
        startedAt: session.startedAt ?? null,
        lastViewedT: session.lastViewedT ?? null,
        lastTimeframeMin: session.lastTimeframeMin ?? null,
        savedAt: Math.floor(Date.now() / 1000),
        trades: Array.isArray(session.trades) ? session.trades : [],
    };
    try {
        s.setItem(keyFor(asset, entryDate), JSON.stringify(payload));
        return true;
    } catch (_) {
        return false;   // quota exceeded / serialization failure
    }
}

/** Load the session for (asset, entryDate), or null if none / unreadable. */
export function loadSession(asset, entryDate) {
    if (!asset || !entryDate) return null;
    const s = safeStorage();
    if (!s) return null;
    let raw;
    try { raw = s.getItem(keyFor(asset, entryDate)); } catch (_) { return null; }
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (!Array.isArray(obj.trades)) obj.trades = [];
        return obj;
    } catch (_) {
        return null;
    }
}

/** Remove the session for (asset, entryDate). */
export function deleteSession(asset, entryDate) {
    const s = safeStorage();
    if (!s) return;
    try { s.removeItem(keyFor(asset, entryDate)); } catch (_) {}
}

/** All stored sessions, newest-saved first. Each entry:
 *  { asset, entryDate, startedAt, lastViewedT, lastTimeframeMin, savedAt, tradeCount }. */
export function listSessions() {
    const s = safeStorage();
    if (!s) return [];
    let len = 0;
    try { len = s.length; } catch (_) { return []; }
    const out = [];
    for (let i = 0; i < len; i++) {
        let k;
        try { k = s.key(i); } catch (_) { continue; }
        if (!k || !k.startsWith(PREFIX)) continue;
        let obj;
        try { obj = JSON.parse(s.getItem(k)); } catch (_) { continue; }
        if (!obj) continue;
        out.push({
            asset: obj.asset,
            entryDate: obj.entryDate,
            startedAt: obj.startedAt ?? null,
            lastViewedT: obj.lastViewedT ?? null,
            lastTimeframeMin: obj.lastTimeframeMin ?? null,
            savedAt: obj.savedAt ?? 0,
            tradeCount: Array.isArray(obj.trades) ? obj.trades.length : 0,
        });
    }
    out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return out;
}
