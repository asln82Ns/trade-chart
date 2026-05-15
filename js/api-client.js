// Thin wrapper around the FastAPI sidecar. Defaults to http://localhost:8001.
// Override at runtime by setting window.TRADE_CHART_API_BASE before main.js loads.

const DEFAULT_BASE = 'http://localhost:8001';

class ApiClient {
    constructor(baseUrl) {
        this.baseUrl = (baseUrl || window.TRADE_CHART_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    }

    async _get(path, params) {
        const url = new URL(this.baseUrl + path);
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                if (v !== undefined && v !== null) url.searchParams.set(k, v);
            }
        }
        const res = await fetch(url.toString(), { method: 'GET' });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).detail || ''; } catch (_) { detail = await res.text(); }
            throw new Error(`API ${path} ${res.status}: ${detail}`);
        }
        return res.json();
    }

    health() { return this._get('/health'); }
    assets() { return this._get('/assets'); }

    splice(asset, start, end) {
        return this._get(`/splice/${encodeURIComponent(asset)}`, { start, end });
    }

    /** Resolve a UTC ISO datetime to its CME trade date. */
    resolveSession(instantIso) {
        return this._get('/resolve_session', { instant: instantIso });
    }

    /**
     * Load spliced 1s bars in entry-contract price space across [from, to].
     * @param {string} asset NG/CL/NQ/GC
     * @param {string} entryDate YYYY-MM-DD
     * @param {string} fromDate YYYY-MM-DD
     * @param {string} toDate YYYY-MM-DD
     */
    load(asset, entryDate, fromDate, toDate) {
        return this._get('/load', {
            asset,
            entry: entryDate,
            from: fromDate,
            to: toDate,
        });
    }

    /** Percentile-rank distributions and within-bar profiles. */
    ranks(asset, timeframeMin, entryDate, lookbackDays) {
        return this._get('/ranks', {
            asset,
            timeframe: timeframeMin,
            entry: entryDate,
            lookback_days: lookbackDays,
        });
    }

    /** Per-bucket ghost-bar shape for replay overlay.
     *
     *  opts: { percentile?: 1..99, dowFilter?: 0..4, womFilter?: 1..5 }.
     *  Defaults match the unfiltered P50 behavior. */
    ghost(asset, timeframeMin, entryDate, lookbackDays, opts = {}) {
        const params = {
            asset,
            timeframe: timeframeMin,
            entry: entryDate,
            lookback_days: lookbackDays,
        };
        if (opts.percentile != null) params.percentile = opts.percentile;
        if (opts.dowFilter != null && opts.dowFilter !== '') params.dow_filter = opts.dowFilter;
        if (opts.womFilter != null && opts.womFilter !== '') params.wom_filter = opts.womFilter;
        return this._get('/ghost', params);
    }

    /** Open the live websocket. Returns the WebSocket — caller wires up handlers. */
    openLive() {
        const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws/live';
        return new WebSocket(wsUrl);
    }

    /** Diagnostic snapshot of the LiveAssetManager (per-asset warmup status,
     *  records received, instrument mappings, etc). */
    liveStatus() { return this._get('/live_status'); }

    /** Weather panel for a forecast vintage date.
     *  See docs/weather-data-spec.md for response shape. */
    weather(dateStr) { return this._get('/weather', { date: dateStr }); }

    /** List currently registered alerts. */
    listAlerts() { return this._get('/alerts'); }

    /** Register a new alert. */
    async createAlert({ asset, metric, op, threshold, tf, lookback }) {
        const url = new URL(this.baseUrl + '/alerts');
        url.searchParams.set('asset', asset);
        url.searchParams.set('metric', metric);
        url.searchParams.set('op', op);
        url.searchParams.set('threshold', threshold);
        url.searchParams.set('tf', tf);
        if (lookback != null) url.searchParams.set('lookback', lookback);
        const res = await fetch(url.toString(), { method: 'POST' });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).detail || ''; } catch (_) { detail = await res.text(); }
            throw new Error(`POST /alerts ${res.status}: ${detail}`);
        }
        return res.json();
    }

    /** Remove an alert by id. */
    async deleteAlert(alertId) {
        const url = new URL(this.baseUrl + `/alerts/${encodeURIComponent(alertId)}`);
        const res = await fetch(url.toString(), { method: 'DELETE' });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).detail || ''; } catch (_) { detail = await res.text(); }
            throw new Error(`DELETE /alerts ${res.status}: ${detail}`);
        }
        return res.json();
    }

    /** Remove every registered alert. */
    async clearAlerts() {
        const url = new URL(this.baseUrl + '/alerts');
        const res = await fetch(url.toString(), { method: 'DELETE' });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).detail || ''; } catch (_) { detail = await res.text(); }
            throw new Error(`DELETE /alerts ${res.status}: ${detail}`);
        }
        return res.json();
    }
}

export default ApiClient;
