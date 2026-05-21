// Weather panel renderer + per-date response cache.
//
// Behavior:
//   - User toggles the Weather button: panel becomes visible and we fetch
//     for the current "anchor" date (today in live mode, the current
//     playhead's session date in replay).
//   - User hovers a bar: the bar's sessionDate becomes the anchor and the
//     panel rerenders for that date. Per-date responses are cached so hover
//     traffic is local-only after the first fetch per session date.
//   - User stops hovering: panel snaps back to the live/playhead anchor.
//
// See docs/weather-data-spec.md for the data semantics.

class WeatherEngine {
    constructor(apiClient, panelEl) {
        this.api = apiClient;
        this.panel = panelEl;          // outer container; we own its innerHTML
        this.enabled = false;
        this.cache = new Map();        // dateStr -> response payload
        this.inflight = new Map();     // dateStr -> Promise (dedupes concurrent fetches)
        this.lastDate = null;          // last date actually rendered
        this.anchorDate = null;        // fallback when no hover (today / playhead)
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (this.panel) this.panel.hidden = !this.enabled;
        if (this.enabled && this.anchorDate && this.lastDate !== this.anchorDate) {
            // Initial render on toggle-on uses the anchor date.
            this.show(this.anchorDate);
        }
    }

    /** Set the no-hover fallback date (today in live, playhead session in replay). */
    setAnchor(dateStr) {
        this.anchorDate = dateStr;
        if (this.enabled && this.lastDate == null) {
            this.show(dateStr);
        }
    }

    /** Render for the given session date (YYYY-MM-DD). Caches per-date so
     *  rapid hover across many bars doesn't generate fetch storms. */
    async show(dateStr) {
        if (!this.enabled || !dateStr) return;
        if (this.lastDate === dateStr) return;
        this.lastDate = dateStr;

        let data = this.cache.get(dateStr);
        if (!data) {
            // Dedupe concurrent fetches for the same date — hover bursts can
            // easily fire 5+ requests for the same bar in a single second.
            let p = this.inflight.get(dateStr);
            if (!p) {
                p = this.api.weather(dateStr).then(resp => {
                    // Only cache responses that are either intentionally
                    // empty (available=false, deferred-data note shown) or
                    // FULLY populated. A response with available=true but
                    // every revision null means the server didn't yet have
                    // yesterday's vintage when it built the panel — caching
                    // it would freeze the user on a stale empty Δ column
                    // even after the neighbor ingestion finishes. Skip
                    // caching; next request re-fetches and gets the
                    // populated revisions.
                    if (_isCompletePanel(resp)) {
                        this.cache.set(dateStr, resp);
                    }
                    this.inflight.delete(dateStr);
                    return resp;
                }).catch(err => {
                    this.inflight.delete(dateStr);
                    throw err;
                });
                this.inflight.set(dateStr, p);
            }
            this._renderPending(dateStr);
            try {
                data = await p;
            } catch (err) {
                this._renderError(dateStr, err);
                return;
            }
            // Stale-check: if the user moved on while we were fetching, skip
            // the render — the next hover already overwrote lastDate.
            if (this.lastDate !== dateStr) return;
        }
        this._render(dateStr, data);
    }

    /** Snap back to anchor (called on hover end). */
    showAnchor() {
        if (this.anchorDate) this.show(this.anchorDate);
    }

    // -------------------- rendering --------------------

    _renderPending(dateStr) {
        if (!this.panel) return;
        this.panel.innerHTML = `
            <div class="weather-header">WEATHER · ${escapeHtml(dateStr)}</div>
            <div class="weather-loading">Loading…</div>`;
    }

    _renderError(dateStr, err) {
        if (!this.panel) return;
        this.panel.innerHTML = `
            <div class="weather-header">WEATHER · ${escapeHtml(dateStr)}</div>
            <div class="weather-error">Error: ${escapeHtml(String(err.message || err))}</div>`;
    }

    _render(dateStr, data) {
        if (!this.panel) return;
        const parts = [];
        parts.push(`<div class="weather-header">WEATHER · ${escapeHtml(dateStr)}</div>`);

        if (!data.available) {
            parts.push(`<div class="weather-empty">
                No vintage forecast data ingested for this date.
                See <code>docs/weather-data-spec.md</code> §10.
            </div>`);
        }

        parts.push(this._renderRegions(data));
        parts.push(this._renderBasins(data));
        parts.push(this._renderAO(data));
        if (data.phase1_note) {
            parts.push(`<div class="weather-note">${escapeHtml(data.phase1_note)}</div>`);
        }

        this.panel.innerHTML = parts.join('');
    }

    _renderRegions(data) {
        const horizons = ['Now', '3D', '5D', '7D', '10D', '14D'];
        const regions = ['national', 'NE', 'MW', 'WSC'];
        const labelMap = { national: 'National', NE: 'Northeast', MW: 'Midwest', WSC: 'S.Central' };

        const rows = [];
        rows.push(`<table class="weather-table"><thead>
            <tr><th class="rname">Degree Days</th>${
                horizons.map(h => `<th>${h}</th>`).join('')
            }</tr></thead><tbody>`);

        for (const r of regions) {
            const cells = horizons.map(h => {
                const v = data.regions?.[r]?.[h];
                if (!v) return `<td class="ddc">—</td>`;
                // Combined H/C cell per spec §1: show whichever dominates,
                // prefixed with H or C.
                const hddVal = v.hdd, cddVal = v.cdd;
                if (hddVal == null && cddVal == null) return `<td class="ddc">—</td>`;
                const hd = hddVal ?? 0;
                const cd = cddVal ?? 0;
                const isHeating = hd >= cd;
                const dominant = isHeating ? hd : cd;
                const cls = isHeating ? 'ddc dd-h' : 'ddc dd-c';
                const prefix = isHeating ? 'H' : 'C';
                return `<td class="${cls}">${prefix} ${dominant.toFixed(0)}</td>`;
            }).join('');
            rows.push(`<tr><th class="rname">${labelMap[r]}</th>${cells}</tr>`);
        }
        rows.push(`</tbody></table>`);

        // Day-over-day revisions (apples-to-apples; spec §4.5).
        rows.push(`<table class="weather-table weather-rev"><thead>
            <tr><th class="rname">Δ vs prior day</th>${
                horizons.map(h => `<th>${h}</th>`).join('')
            }</tr></thead><tbody>`);
        for (const r of regions) {
            const cells = horizons.map(h => {
                const v = data.revisions?.[r]?.[h];
                if (!v) return `<td class="ddc">—</td>`;
                // Show the revision of the SAME metric the DD cell above
                // displays. `v.hdd ?? v.cdd` is WRONG: in summer HDD is 0
                // (not null), so ?? returns 0 and the real CDD signal is
                // never shown — the Δ column reads a constant 0. Pick the
                // dominant metric exactly as the DD row does.
                const key = dominantMetric(data, r, h, v);
                const delta = v[key];
                if (delta == null) return `<td class="ddc">—</td>`;
                const sign = delta > 0 ? '+' : '';
                // Tint by TEMPERATURE direction (spec §8), not raw sign:
                //   +HDD Δ = colder forecast revision  → blue (rev-up)
                //   +CDD Δ = warmer forecast revision  → red  (rev-dn)
                // Flip CDD so both metrics map onto the same colder=blue /
                // warmer=red scale. The displayed number keeps its true sign.
                const tdir = key === 'cdd' ? -delta : delta;
                const tint = tdir > 0 ? 'rev-up' : (tdir < 0 ? 'rev-dn' : '');
                return `<td class="ddc ${tint}">${sign}${delta.toFixed(0)}</td>`;
            }).join('');
            rows.push(`<tr><th class="rname">${labelMap[r]}</th>${cells}</tr>`);
        }
        rows.push(`</tbody></table>`);

        // Modified Z-score row (spec §4.6).
        rows.push(`<table class="weather-table weather-z"><thead>
            <tr><th class="rname">Z (revision)</th>${
                horizons.map(h => `<th>${h}</th>`).join('')
            }</tr></thead><tbody>`);
        for (const r of regions) {
            const cells = horizons.map(h => {
                const v = data.z_scores?.[r]?.[h];
                if (!v) return `<td class="ddc">—</td>`;
                // Same dominant-metric selection as the Δ row (see note).
                const key = dominantMetric(data, r, h, v);
                const z = v[key];
                if (z == null) return `<td class="ddc">—</td>`;
                const abs = Math.abs(z);
                const cls = abs >= 3 ? 'z-extreme' : (abs >= 2 ? 'z-high' : '');
                return `<td class="ddc ${cls}">${z.toFixed(1)}</td>`;
            }).join('');
            rows.push(`<tr><th class="rname">${labelMap[r]}</th>${cells}</tr>`);
        }
        rows.push(`</tbody></table>`);

        return rows.join('');
    }

    _renderBasins(data) {
        const horizons = ['Now', '5D', '10D', '14D'];
        const basins = ['permian', 'marcellus', 'haynesville'];
        const labelMap = { permian: 'Permian', marcellus: 'Marcellus', haynesville: 'Haynesville' };
        const rows = [];
        rows.push(`<table class="weather-table weather-basins"><thead>
            <tr><th class="rname">Basin Tmin (°F)</th>${
                horizons.map(h => `<th>${h}</th>`).join('')
            }</tr></thead><tbody>`);
        for (const b of basins) {
            const cells = horizons.map(h => {
                const v = data.basins?.[b]?.[h];
                if (v == null) return `<td class="ddc">—</td>`;
                // Color thresholds per spec §4.7.
                let cls = 'ddc';
                if (v < 20) cls += ' frz-high';
                else if (v < 32) cls += ' frz-mod';
                return `<td class="${cls}">${v.toFixed(0)}</td>`;
            }).join('');
            rows.push(`<tr><th class="rname">${labelMap[b]}</th>${cells}</tr>`);
        }
        rows.push(`</tbody></table>`);
        return rows.join('');
    }

    _renderAO(data) {
        const ao = data.ao || {};
        const now = ao.now != null ? ao.now.toFixed(2) : '—';
        const rev = ao.revision != null ? `${ao.revision >= 0 ? '+' : ''}${ao.revision.toFixed(2)}` : '—';
        const z = ao.z != null ? ao.z.toFixed(2) : '—';
        return `
            <div class="weather-ao">
              <div class="weather-ao-row">
                <span class="rname">AO Index</span>
                <span>now ${now}</span>
                <span>Δ ${rev}</span>
                <span>Z ${z}</span>
              </div>
            </div>`;
    }
}

/** Heuristic: is this panel "complete enough" to cache?
 *  - available=false → intentionally empty (pre-2021-04 vintage) — cache
 *  - available=true and ALL revision cells null → ingestion was incomplete
 *    when this panel was built (yesterday's vintage not yet in cache) — DO
 *    NOT cache, force re-fetch on next hover.
 *  - otherwise → cache normally. */
function _isCompletePanel(data) {
    if (!data || data.available === false) return true;
    const revs = data.revisions || {};
    let anyRevisionPresent = false;
    for (const region of Object.keys(revs)) {
        for (const horizon of Object.keys(revs[region] || {})) {
            const cell = revs[region][horizon] || {};
            if (cell.hdd != null || cell.cdd != null) {
                anyRevisionPresent = true;
                break;
            }
        }
        if (anyRevisionPresent) break;
    }
    return anyRevisionPresent;
}

/** Which metric ('hdd'|'cdd') the DD cell displays for this region/horizon.
 *  This MUST match the DD cell's `isHeating = hd >= cd` rule exactly so the
 *  Δ and Z rows show the revision/Z of the number printed directly above
 *  them. Falls back to whichever of the supplied cell's values is the
 *  larger-magnitude non-null one when the DD cell is unavailable. */
function dominantMetric(data, region, horizon, fallbackCell) {
    const dd = data.regions?.[region]?.[horizon];
    if (dd && (dd.hdd != null || dd.cdd != null)) {
        return (dd.hdd ?? 0) >= (dd.cdd ?? 0) ? 'hdd' : 'cdd';
    }
    const h = fallbackCell?.hdd, c = fallbackCell?.cdd;
    if (h == null && c == null) return 'cdd';
    if (h == null) return 'cdd';
    if (c == null) return 'hdd';
    return Math.abs(h) >= Math.abs(c) ? 'hdd' : 'cdd';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

export default WeatherEngine;
