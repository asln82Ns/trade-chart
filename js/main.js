// Application entry point — wires the UI to the API client, chart,
// playback engine, and trade simulator.

import ApiClient from './api-client.js';
import ChartController from './chart-controller.js';
import PlaybackEngine from './playback-engine.js';
import LiveEngine from './live-engine.js';
import TradeSimulator from './trade-simulator.js';
import RankEngine from './rank-engine.js';
import GhostEngine from './ghost-engine.js';
import WeatherEngine from './weather-engine.js';
import RankCompareEngine from './rank-compare-engine.js';
import TrendStatusEngine from './trend-status-engine.js';
import * as AssetCfg from './asset-config.js';
import * as ReplayStore from './replay-store.js';
import { computeMetrics, equityCurve } from './metrics.js';
import { TIMEFRAMES, formatEt, etDateString, etLocalStringToUnix, weatherIssuanceDate } from './time-utils.js';

const CONTEXT_DAYS = 10;     // weekdays of pre-entry history to load up front
const FORWARD_DAYS_INITIAL = 5;
const FORWARD_DAYS_PREFETCH = 5;
const MAX_LOADED_SESSIONS = 30;

class App {
    constructor() {
        this.api = new ApiClient();
        this.chart = null;
        this.simulator = null;
        this.engine = null;            // PlaybackEngine (replay)
        this.liveEngine = null;        // LiveEngine (live)
        this.activeEngine = null;      // points to current mode's engine
        this.currentAsset = null;
        this.currentEntryDate = null;     // YYYY-MM-DD ET (replay) or live prime entry
        this.lastLoadedSession = null;    // YYYY-MM-DD ET
        this.firstLoadedSession = null;
        // Mode resolution order (highest precedence first):
        //   1. ?mode=live|replay URL parameter — lets the user bookmark a
        //      tab in a fixed mode (open one tab as live, another as
        //      replay, both work independently).
        //   2. sessionStorage — per-tab persistence; survives reload but
        //      doesn't bleed across tabs the way localStorage did.
        //   3. default 'replay'.
        let initialMode = 'replay';
        try {
            const urlMode = new URLSearchParams(window.location.search).get('mode');
            if (urlMode === 'live' || urlMode === 'replay') {
                initialMode = urlMode;
            } else {
                const stored = sessionStorage.getItem('tradeChart.mode');
                if (stored === 'live' || stored === 'replay') initialMode = stored;
            }
        } catch (_) { /* sandbox without URL/sessionStorage; keep default */ }
        this.mode = initialMode;
        // The live WebSocket is opened once at startup and persists for the
        // whole session, regardless of mode. It serves two channels: per-asset
        // bar streaming (subscribed only while the user is connected in live
        // mode) and a global alert broadcast that flows continuously.
        this._liveWs = null;
        this._wantsLiveAsset = null;       // asset we should resubscribe to on (re)connect
        this._wsReconnectTimer = null;
        // Frontend rank cache keyed by `${asset}|${tf}|${entry}|${lookback}`.
        // Switching back to a previously-fetched timeframe is then instant.
        this._rankCache = new Map();
        // Generation token for _ensureRanks. Incremented on every call so a
        // late-resolving fetch from a prior asset/timeframe can't overwrite
        // the rankEngine after the user has moved on.
        this._rankGen = 0;
        this._liveStatusPollTimer = null;
        // Replay-session persistence (localStorage), replay mode only.
        //   _replaySession: { asset, entryDate, startedAt, lastViewedT, lastTimeframeMin }
        // null whenever no replay scenario is loaded (incl. live mode).
        this._replaySession = null;
        this._lastPersistedTradeCount = 0;
        // Cumulative-return chart inside the Trade Log modal (lightweight-charts,
        // created lazily the first time the panel is expanded).
        this._equityChart = null;
        this._equitySeries = null;
        this._equityPoints = [];
        // Ghost-mode state (replay only). Cache mirrors _rankCache shape but
        // its key includes the filter params so each (percentile, dow, wom)
        // combo lives in its own slot. Anchor mode is render-side only and
        // doesn't affect the fetched payload.
        this._ghostEnabled = false;
        this._ghostCache = new Map();
        this._ghostGen = 0;
        this._ghostConfig = {
            percentile: 50,
            dowFilter: '',     // '' = Any
            womFilter: '',
            anchor: 'session', // 'session' | 'realtime'
        };
        this._initUi();
    }

    async init() {
        try {
            await this.api.health();
        } catch (e) {
            this._status(`Cannot reach API at ${this.api.baseUrl}. Is uvicorn running?`);
            return;
        }
        try {
            const { assets } = await this.api.assets();
            AssetCfg.setAssets(assets);
            for (const a of assets) {
                const opt = document.createElement('option');
                opt.value = a.symbol;
                opt.dataset.baseLabel = a.symbol;
                opt.textContent = a.symbol;
                opt.title = a.name;  // full name still visible on hover
                this.el.assetSelect.appendChild(opt);
            }
            this.el.assetSelect.disabled = false;
            this.el.assetSelect.value = assets[0]?.symbol || '';
            this.currentAsset = assets[0] || null;
        } catch (e) {
            this._status(`Failed to load /assets: ${e.message}`);
            return;
        }
        for (const tf of TIMEFRAMES) {
            const opt = document.createElement('option');
            opt.value = tf.value;
            opt.textContent = tf.label;
            this.el.timeframeSelect.appendChild(opt);
            // Populate the alerts timeframe select too.
            const optA = document.createElement('option');
            optA.value = tf.value;
            optA.textContent = tf.label;
            this.el.alertTimeframe.appendChild(optA);
        }
        this.el.timeframeSelect.value = '5';
        this.el.alertTimeframe.value = '90';
        this.el.timeframeSelect.disabled = false;
        // Mirror the asset list into the alerts asset select. Prepend an
        // "All" option that fans out a single Save into N per-asset alerts.
        const allOpt = document.createElement('option');
        allOpt.value = '*';
        allOpt.textContent = 'All';
        this.el.alertAsset.appendChild(allOpt);
        for (const opt of this.el.assetSelect.options) {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.value;
            this.el.alertAsset.appendChild(o);
        }
        this._refreshAlertList();
        this.el.entryDate.disabled = false;
        this.el.loadBtn.disabled = false;
        this.el.connectBtn.disabled = !this.currentAsset;
        this._updateTickValue();
        this._setMode(this.mode, true);
        this._refreshLiveStatus();
        this._refreshResumeDropdown();
        // Open the persistent live WS now so alerts can fire regardless of
        // whether the user has clicked Connect or is in Replay mode.
        this._setupWs();
    }

    _initUi() {
        this.el = {
            assetSelect: document.getElementById('assetSelect'),
            entryDate: document.getElementById('entryDate'),
            entryDateLabel: document.getElementById('entryDateLabel'),
            timeframeSelect: document.getElementById('timeframeSelect'),
            lookbackInput: document.getElementById('lookbackInput'),
            loadBtn: document.getElementById('loadBtn'),
            connectBtn: document.getElementById('connectBtn'),
            disconnectBtn: document.getElementById('disconnectBtn'),
            modeReplayBtn: document.getElementById('modeReplayBtn'),
            modeLiveBtn: document.getElementById('modeLiveBtn'),
            playbackControlsRow: document.querySelector('.playback-controls-inline'),
            tickValueDisplay: document.getElementById('tickValueDisplay'),
            dollarRiskDisplay: document.getElementById('dollarRiskDisplay'),
            advPriceDisplay: document.getElementById('advPriceDisplay'),
            addQuantityDisplay: document.getElementById('addQuantityDisplay'),
            riskTargetEnable: document.getElementById('riskTargetEnable'),
            distPctInput: document.getElementById('distPctInput'),
            alertsSection: document.getElementById('alertsSection'),
            alertAsset: document.getElementById('alertAsset'),
            alertMetric: document.getElementById('alertMetric'),
            alertOp: document.getElementById('alertOp'),
            alertThreshold: document.getElementById('alertThreshold'),
            alertTimeframe: document.getElementById('alertTimeframe'),
            alertSaveBtn: document.getElementById('alertSaveBtn'),
            alertClearBtn: document.getElementById('alertClearBtn'),
            alertList: document.getElementById('alertList'),
            alertNotifications: document.getElementById('alertNotifications'),
            muteRankAlerts: document.getElementById('muteRankAlerts'),
            mutePendingAlerts: document.getElementById('mutePendingAlerts'),
            riskTargetInput: document.getElementById('riskTargetInput'),
            playBtn: document.getElementById('playBtn'),
            pauseBtn: document.getElementById('pauseBtn'),
            resetBtn: document.getElementById('resetBtn'),
            speedControl: document.getElementById('speedControl'),
            speedPresetInputs: document.querySelectorAll('.speed-preset-value'),
            speedPresetApplyBtns: document.querySelectorAll('.speed-preset-apply'),
            status: document.getElementById('status'),
            warmupPill: document.getElementById('warmupPill'),
            currentTime: document.getElementById('currentTime'),
            currentContract: document.getElementById('currentContract'),
            currentOpen: document.getElementById('currentOpen'),
            currentHigh: document.getElementById('currentHigh'),
            currentLow: document.getElementById('currentLow'),
            currentClose: document.getElementById('currentClose'),
            barVolume: document.getElementById('barVolume'),
            volRank: document.getElementById('volRank'),
            volPendingRank: document.getElementById('volPendingRank'),
            rangeRank: document.getElementById('rangeRank'),
            rangePendingRank: document.getElementById('rangePendingRank'),
            volRankIdx: document.getElementById('volRankIdx'),
            volPendingRankIdx: document.getElementById('volPendingRankIdx'),
            rangeRankIdx: document.getElementById('rangeRankIdx'),
            rangePendingRankIdx: document.getElementById('rangePendingRankIdx'),
            volRankInfo: document.getElementById('volRankInfo'),
            volPendingInfo: document.getElementById('volPendingInfo'),
            rangeRankInfo: document.getElementById('rangeRankInfo'),
            rangePendingInfo: document.getElementById('rangePendingInfo'),
            resumeSessionSelect: document.getElementById('resumeSessionSelect'),
            resumeLabel: document.getElementById('resumeLabel'),
            loadedSessions: document.getElementById('loadedSessions'),
            tapePos: document.getElementById('tapePos'),
            tickTime: document.getElementById('tickTime'),
            prefetchStatus: document.getElementById('prefetchStatus'),
            buyBtn: document.getElementById('buyBtn'),
            sellBtn: document.getElementById('sellBtn'),
            flattenBtn: document.getElementById('flattenBtn'),
            stopPriceInput: document.getElementById('stopPriceInput'),
            buyStopBtn: document.getElementById('buyStopBtn'),
            sellStopBtn: document.getElementById('sellStopBtn'),
            pendingStopsList: document.getElementById('pendingStopsList'),
            quantityInput: document.getElementById('quantityInput'),
            tradeLogBtn: document.getElementById('tradeLogBtn'),
            positionDisplay: document.getElementById('positionDisplay'),
            avgEntryDisplay: document.getElementById('avgEntryDisplay'),
            realizedPnL: document.getElementById('realizedPnL'),
            unrealizedPnL: document.getElementById('unrealizedPnL'),
            totalPnL: document.getElementById('totalPnL'),
            tradeLogModal: document.getElementById('tradeLogModal'),
            tradeLogContent: document.getElementById('tradeLogContent'),
            tradeMetricsContent: document.getElementById('tradeMetricsContent'),
            equityDetails: document.getElementById('equityDetails'),
            equityChart: document.getElementById('equityChart'),
            downloadCsvBtn: document.getElementById('downloadCsvBtn'),
            clearLogBtn: document.getElementById('clearLogBtn'),
            closeModal: document.querySelector('.close-modal'),
            chartContainer: document.getElementById('chartContainer'),
            ghostBtn: document.getElementById('ghostBtn'),
            ghostInfoItem: document.getElementById('ghostInfoItem'),
            contractSplitFlag: document.getElementById('contractSplitFlag'),
            ghostInfo: document.getElementById('ghostInfo'),
            ghostConfigGroup: document.getElementById('ghostConfigGroup'),
            ghostPercentile: document.getElementById('ghostPercentile'),
            ghostDow: document.getElementById('ghostDow'),
            ghostWom: document.getElementById('ghostWom'),
            ghostAnchor: document.getElementById('ghostAnchor'),
            weatherToggleBtn: document.getElementById('weatherToggleBtn'),
            weatherPanel: document.getElementById('weatherPanel'),
            rankCompareBtn: document.getElementById('rankCompareBtn'),
            rankComparePanel: document.getElementById('rankComparePanel'),
            trendStatusBtn: document.getElementById('trendStatusBtn'),
            trendStatusPanel: document.getElementById('trendStatusPanel'),
        };

        // Weather panel: opt-in via toggle button; updates on bar hover and
        // snaps back to a sensible anchor (today/playhead session) on hover-end.
        // See docs/weather-data-spec.md for what the panel shows and why.
        this.weather = new WeatherEngine(this.api, this.el.weatherPanel);
        // Rank-compare panel (replay only): cross-asset Vol / Range rank +
        // open-to-close at the same TF and playback position.
        this.rankCompare = new RankCompareEngine(this.api, this.el.rankComparePanel);

        this.chart = new ChartController(this.el.chartContainer);
        this.chart.setContractsChangeCallback((contracts) => this._renderContractSplitFlag(contracts));
        // Trend-status panel: pure-local buy/sell-strength strips computed off
        // the chart's live candle array. No fetch — just reads getCandleData().
        this.trendStatus = new TrendStatusEngine(
            this.el.trendStatusPanel, () => this.chart.getCandleData());
        this.simulator = new TradeSimulator();
        this.engine = new PlaybackEngine(this.chart, this.simulator);
        this.engine.maxSessions = MAX_LOADED_SESSIONS;
        this.liveEngine = new LiveEngine(this.chart, this.simulator);
        this.activeEngine = this.engine;
        this.rankEngine = new RankEngine();
        this.ghostEngine = new GhostEngine();
        this._lastTickT = null;

        this.engine.onTick(({ formingBar, tapeIndex, tapeLength, tick }) => {
            // Always-live readouts (cursor-independent): tape position, live
            // tick clock, and _lastTickT (rank lookups need it on hover-end).
            this.el.tapePos.textContent = `${tapeIndex} / ${tapeLength}`;
            if (tick) {
                this._lastTickT = tick.t;
                if (this._replaySession) {
                    this._replaySession.lastViewedT = Math.max(this._replaySession.lastViewedT ?? 0, tick.t);
                }
                this.el.tickTime.textContent = formatEt(tick.t, { label: true, withSeconds: true });
                // Rank-compare panel tracks playhead independently of hover —
                // it has its own bucket logic and prefetch watermark.
                if (this.rankCompare) this.rankCompare.setPlayhead(tick.t);
                if (this.trendStatus) this.trendStatus.refresh();
            }
            // Bar-derived readouts (Time/OHLC/Volume/Contract/Ranks/Risk): only
            // overwrite if the user isn't inspecting a historical bar.
            if (this.chart.isHovering()) return;
            // Not hovering: the weather panel follows the playhead, gated by
            // the latest tick's UTC time so it never shows a forecast the
            // replayed "now" couldn't have seen yet. setAnchor keeps the
            // hover-end snap-back target correct; show() advances the display
            // across day boundaries (both dedupe on unchanged date).
            if (this.weather && this.weather.enabled && this._lastTickT != null) {
                const wd = weatherIssuanceDate(this._lastTickT);
                this.weather.setAnchor(wd);
                this.weather.show(wd);
            }
            this._updateBarInfo(formingBar);
            if (tick && tick.k) this.el.currentContract.textContent = tick.k;
            if (formingBar) this._updateRankInfo(formingBar, this._lastTickT);
        });
        this.engine.onPrefetchNeeded(async (lastSession) => {
            await this._prefetchForward();
        });
        this.engine.onPlaybackEnd(() => {
            this._persistReplaySession();
            this._status('Playback complete. Press Reset to replay or change asset/date.');
            this.el.playBtn.disabled = false;
            this.el.pauseBtn.disabled = true;
            this.el.buyBtn.disabled = true;
            this.el.sellBtn.disabled = true;
            this.el.flattenBtn.disabled = true;
            this.el.buyStopBtn.disabled = true;
            this.el.sellStopBtn.disabled = true;
        });
        this.engine.onSessionEvicted(() => {
            this.el.loadedSessions.textContent = this.engine.getLoadedSessionCount();
        });

        this.liveEngine.onTick(({ tick, formingBar }) => {
            // Live tick clock + _lastTickT always update; bar-derived readouts
            // hold whatever the cursor is hovering (see engine.onTick rationale).
            if (tick) {
                this._lastTickT = tick.t;
                this.el.tickTime.textContent = formatEt(tick.t, { label: true, withSeconds: true });
            }
            if (this.trendStatus) this.trendStatus.refresh();
            if (this.chart.isHovering()) return;
            if (formingBar) this._updateBarInfo(formingBar);
            if (tick && tick.k) this.el.currentContract.textContent = tick.k;
            if (formingBar) this._updateRankInfo(formingBar, this._lastTickT);
        });

        this.simulator.onUpdate((s) => {
            this._updateTradeInfo(s);
            // Persist the replay session whenever the completed-trade count
            // changes (a trade closed). Cheap; localStorage writes are sync.
            if (this.mode === 'replay' && this._replaySession) {
                const c = this.simulator.getCompletedTrades().length;
                if (c !== this._lastPersistedTradeCount) {
                    this._lastPersistedTradeCount = c;
                    this._persistReplaySession();
                }
            }
        });
        this.simulator.onStopsChanged((stops) => this._renderPendingStops(stops));
        this.chart.setHoverCallback((data) => {
            // Hover wins over live ticks: while the cursor is on a bar, the
            // bar-info row reflects THAT bar — even mid-replay/mid-live. The
            // engine.onTick / liveEngine.onTick handlers check chart.isHovering()
            // and skip their bar-info writes so they don't overwrite us.
            this.el.currentOpen.textContent = data.open?.toFixed(this.currentAsset?.price_decimals ?? 2) ?? '--';
            this.el.currentHigh.textContent = data.high?.toFixed(this.currentAsset?.price_decimals ?? 2) ?? '--';
            this.el.currentLow.textContent = data.low?.toFixed(this.currentAsset?.price_decimals ?? 2) ?? '--';
            this.el.currentClose.textContent = data.close?.toFixed(this.currentAsset?.price_decimals ?? 2) ?? '--';
            this.el.barVolume.textContent = (data.volume ?? 0).toLocaleString();
            this.el.currentTime.textContent = formatEt(data.time, { label: true });
            this.el.currentContract.textContent = data.contract || '--';
            // Hovered bar gets ranks too. For historical bars, currentTickT past
            // the bar boundary -> p=1 (final). For the live forming bar, use _lastTickT.
            this._updateRankInfo(data, this._lastTickT);
            this._updateDollarRisk(data);
            this._updateGhostInfo(data.ghost);
            // Weather panel: show the newest forecast issuance the hovered
            // bar could actually have seen — gated by the bar's UTC time
            // (06:00Z availability cutoff), NOT its session date. Keying on
            // session date leaked hindsight: a session's overnight-Globex
            // bars would display that day's 00Z run hours before it was
            // published. See weatherIssuanceDate / spec §7.
            if (this.weather && this.weather.enabled && data.time) {
                this.weather.show(weatherIssuanceDate(data.time));
            }
            // Rank-compare panel: hover overrides playhead bucket.
            if (this.rankCompare) this.rankCompare.setHoverBar(data.time);
            // Trend-status panel: recompute as if the hovered bar were latest.
            if (this.trendStatus) this.trendStatus.setHoverBar(data.time);
        });
        this.chart.setHoverEndCallback(() => {
            // Cursor left a bar: snap the bar-info row back to the current
            // forming bar so the readout stays in sync with whatever's playing.
            const formingBar = this.activeEngine?.getCurrentState?.().formingBar;
            if (!formingBar) return;
            this._updateBarInfo(formingBar);
            this._updateRankInfo(formingBar, this._lastTickT);
            // Ghost info is derived from chart-side metadata for hovered bars
            // only; with no hover, fall back to whatever ghost state already
            // applies (ghost engine repaints separately on tick).
            if (this.weather && this.weather.enabled) {
                this.weather.showAnchor();
            }
            // Rank-compare panel: drop hover override → snap back to playhead.
            if (this.rankCompare) this.rankCompare.setHoverBar(null);
            // Trend-status panel: snap back to the live/forming bar.
            if (this.trendStatus) this.trendStatus.setHoverBar(null);
        });

        this.el.assetSelect.addEventListener('change', (e) => {
            try { this.currentAsset = AssetCfg.getAsset(e.target.value); }
            catch (_) { this.currentAsset = null; }
            this._updateTickValue();
            if (this.mode === 'live' && this._liveWs) {
                // Auto-resubscribe to the new asset.
                this._connectLive();
            }
            if (this.mode === 'live') {
                this.el.connectBtn.disabled = !this.currentAsset;
            }
        });
        this.el.timeframeSelect.addEventListener('change', async (e) => {
            const tf = parseInt(e.target.value, 10);
            // Old timeframe's bucket distributions don't match new bars'
            // time-of-day buckets — clear before re-aggregating so stale
            // ranks/ghost aren't shown during the /ranks fetch.
            this.rankEngine.clear();
            this.ghostEngine.clear();
            this.ghostEngine.setTimeframeMin(Number.isFinite(tf) ? tf : 0);
            this.simulator.timeframeMin = Number.isFinite(tf) ? tf : 0;
            if (this.mode === 'replay') {
                this.engine.setTimeframe(tf);
                if (this.currentEntryDate && this.currentAsset) {
                    await this._ensureRanks(this.currentAsset.symbol, tf,
                                            this.currentEntryDate, this._readLookbackDays());
                    if (this._ghostEnabled) {
                        await this._ensureGhost(this.currentAsset.symbol, tf,
                                                this.currentEntryDate, this._readLookbackDays());
                    }
                    // Other-asset ranks are timeframe-keyed too; rebuild.
                    this._refreshRankCompareContext();
                }
            } else {
                this.liveEngine.setTimeframe(tf);
                if (this.currentAsset && this._liveEntrySession) {
                    await this._ensureRanks(this.currentAsset.symbol, tf,
                                            this._liveEntrySession, this._readLookbackDays());
                }
            }
            // Bars were rebuilt at the new timeframe; drop any stale hover
            // index and repaint (matters while paused — no tick to self-correct).
            if (this.trendStatus) {
                this.trendStatus.setHoverBar(null);
                this.trendStatus.refresh();
            }
        });
        this.el.loadBtn.addEventListener('click', () => this._load());
        this.el.ghostBtn.addEventListener('click', () => this._toggleGhost());
        this.el.weatherToggleBtn.addEventListener('click', () => this._toggleWeather());
        this.el.rankCompareBtn.addEventListener('click', () => this._toggleRankCompare());
        this.el.trendStatusBtn.addEventListener('click', () => this._toggleTrendStatus());
        // Filter / percentile changes refetch from the server (raw cache is
        // shared across filter combos, so this is fast after the first build).
        // Anchor change is render-side only — no fetch needed.
        this.el.ghostPercentile.addEventListener('change', (e) => {
            this._ghostConfig.percentile = parseInt(e.target.value, 10) || 50;
            this._refetchGhostIfActive();
        });
        this.el.ghostDow.addEventListener('change', (e) => {
            this._ghostConfig.dowFilter = e.target.value; // '' or '0'..'4'
            this._refetchGhostIfActive();
        });
        this.el.ghostWom.addEventListener('change', (e) => {
            this._ghostConfig.womFilter = e.target.value;
            this._refetchGhostIfActive();
        });
        this.el.ghostAnchor.addEventListener('change', (e) => {
            this._ghostConfig.anchor = (e.target.value === 'realtime') ? 'realtime' : 'session';
            this._applyGhostAnchor();
        });
        this.el.playBtn.addEventListener('click', () => this._play());
        this.el.pauseBtn.addEventListener('click', () => this._pause());
        this.el.resetBtn.addEventListener('click', () => this._reset());
        this.el.modeReplayBtn.addEventListener('click', () => this._setMode('replay'));
        this.el.modeLiveBtn.addEventListener('click', () => this._setMode('live'));
        this.el.connectBtn.addEventListener('click', () => this._connectLive());
        this.el.disconnectBtn.addEventListener('click', () => this._disconnectLive(true));
        this.el.alertSaveBtn.addEventListener('click', () => this._saveAlert());
        this.el.alertClearBtn.addEventListener('click', () => this._clearAllAlerts());
        // $ Target change refreshes everything that depends on it: Qty input
        // (via _recalcQuantityFromTarget inside _updateDollarRisk) AND the
        // view-only Add Qty display. Falls back to bare _recalcQuantityFromTarget
        // when no bar is loaded yet (Add Qty has nothing to show anyway).
        this.el.riskTargetInput.addEventListener('input', () => {
            const formingBar = this.activeEngine?.getCurrentState?.().formingBar;
            if (formingBar) this._updateDollarRisk(formingBar);
            else this._recalcQuantityFromTarget();
        });
        // Dist % change re-runs the risk math against the current forming bar
        // (the live readout the user is looking at). Hover-state stays as-is;
        // moving the cursor refreshes the hovered bar through the existing hover
        // path. Listening on 'input' (not 'change') fires while the user types.
        this.el.distPctInput.addEventListener('input', () => {
            const formingBar = this.activeEngine?.getCurrentState?.().formingBar;
            if (formingBar) this._updateDollarRisk(formingBar);
        });
        // Auto-update toggle: immediate feedback on re-enable (recalc Qty now
        // instead of waiting for the next tick / hover).
        this.el.riskTargetEnable.addEventListener('change', () => this._recalcQuantityFromTarget());

        // Per-group alert mute. Persisted in localStorage (intentionally
        // global, not per-tab — these are user preferences, not per-session
        // state). Banner + chip behavior is unchanged; only the beep is gated.
        const MUTE_RANK_KEY = 'tradeChart.muteRankAlerts';
        const MUTE_PENDING_KEY = 'tradeChart.mutePendingAlerts';
        try {
            this.el.muteRankAlerts.checked = localStorage.getItem(MUTE_RANK_KEY) === '1';
            this.el.mutePendingAlerts.checked = localStorage.getItem(MUTE_PENDING_KEY) === '1';
        } catch (_) { /* storage unavailable */ }
        this.el.muteRankAlerts.addEventListener('change', (e) => {
            try { localStorage.setItem(MUTE_RANK_KEY, e.target.checked ? '1' : '0'); } catch (_) {}
        });
        this.el.mutePendingAlerts.addEventListener('change', (e) => {
            try { localStorage.setItem(MUTE_PENDING_KEY, e.target.checked ? '1' : '0'); } catch (_) {}
        });

        const clampSpeed = (raw) => {
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? Math.max(1, Math.min(5000, n)) : 1;
        };
        const applySpeed = (raw) => {
            const s = clampSpeed(raw);
            this.el.speedControl.value = s;
            this.engine.setSpeed(s);
        };
        this.el.speedControl.addEventListener('input', (e) => applySpeed(e.target.value));
        this.el.speedControl.addEventListener('change', (e) => applySpeed(e.target.value));

        const PRESET_KEY = 'tradeChart.speedPresets';
        const presetCount = this.el.speedPresetInputs.length;
        const defaultPresets = [...this.el.speedPresetInputs].map(inp => clampSpeed(inp.value));
        try {
            const raw = localStorage.getItem(PRESET_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length === presetCount) {
                    this.el.speedPresetInputs.forEach((inp, i) => {
                        inp.value = clampSpeed(parsed[i] ?? defaultPresets[i]);
                    });
                }
            }
        } catch (_) { /* ignore storage errors */ }
        const savePresets = () => {
            const arr = [...this.el.speedPresetInputs].map(inp => clampSpeed(inp.value));
            try { localStorage.setItem(PRESET_KEY, JSON.stringify(arr)); } catch (_) {}
        };
        this.el.speedPresetInputs.forEach((inp) => {
            inp.addEventListener('change', () => {
                inp.value = clampSpeed(inp.value);
                savePresets();
            });
        });
        this.el.speedPresetApplyBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                const wrapper = btn.closest('.speed-preset');
                const inp = wrapper?.querySelector('.speed-preset-value');
                if (inp) applySpeed(inp.value);
            });
        });

        // Resume dropdown (replay only): repopulate on mousedown so the list
        // is always fresh (avoids plumbing into every save/delete site), and
        // on change, fill the form fields so the user can click Load and
        // hit the existing _peekResumeSession resume-confirm path.
        this.el.resumeSessionSelect.addEventListener('mousedown', () => this._refreshResumeDropdown());
        this.el.resumeSessionSelect.addEventListener('change', () => this._onResumeSelected());

        this.el.buyBtn.addEventListener('click', () => this._placeOrder('buy'));
        this.el.sellBtn.addEventListener('click', () => this._placeOrder('sell'));
        this.el.flattenBtn.addEventListener('click', () => this._flatten());
        this.el.buyStopBtn.addEventListener('click', () => this._placeStopOrder('buy'));
        this.el.sellStopBtn.addEventListener('click', () => this._placeStopOrder('sell'));
        this.el.tradeLogBtn.addEventListener('click', () => this._showTradeLog());
        this.el.closeModal.addEventListener('click', () => this._closeTradeLog());
        this.el.downloadCsvBtn.addEventListener('click', () => this._downloadTradeCsv());
        this.el.clearLogBtn.addEventListener('click', () => this._clearTradeLog());
        this.el.equityDetails.addEventListener('toggle', () => {
            if (this.el.equityDetails.open) this._ensureEquityChart();
        });
        window.addEventListener('click', (e) => {
            if (e.target === this.el.tradeLogModal) this._closeTradeLog();
        });
        // Best-effort flush of the active replay session on tab close.
        window.addEventListener('beforeunload', () => this._persistReplaySession());

        // Default entry: today 09:30 ET (just a sane prefill).
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        this.el.entryDate.value = `${yyyy}-${mm}-${dd}T09:30`;
    }

    async _load() {
        if (!this.currentAsset || !this.el.entryDate.value) return;
        this._status('Loading...');
        this.el.loadBtn.disabled = true;
        try {
            const entryUnix = etLocalStringToUnix(this.el.entryDate.value);
            if (entryUnix === null) throw new Error('Could not parse entry datetime');
            // Resolve to a CME trade date.
            const resolved = await this.api.resolveSession(new Date(entryUnix * 1000).toISOString());
            const entryDate = resolved.trade_date;            // YYYY-MM-DD
            const tf = parseInt(this.el.timeframeSelect.value, 10);

            // Peek + prompt for resume BEFORE the fetch so the load window can
            // be sized based on the user's choice. A resumed session whose
            // lastViewedT sits past the default forward window (the common case
            // for long-running sessions that prefetched many sessions forward)
            // loads a small slice around lastViewedT — not months of contiguous
            // bars from the original entry. entryUnix stays at the original
            // entry; the engine's contextEndIndex naturally falls to 0 on a
            // shifted tape (entry is before tape[0]), and seekTo lands the
            // playback head on lastViewedT inside the loaded slice.
            const resumePeek = this._peekResumeSession(this.currentAsset.symbol, entryDate);
            let fromDate = await this._addTradeDays(entryDate, -CONTEXT_DAYS);
            let toDate = await this._addTradeDays(entryDate, FORWARD_DAYS_INITIAL);
            if (resumePeek.resume && resumePeek.saved && resumePeek.saved.lastViewedT) {
                const lastViewedDate = etDateString(resumePeek.saved.lastViewedT);
                // Lexicographic compare on YYYY-MM-DD is valid (zero-padded).
                if (lastViewedDate > toDate) {
                    fromDate = await this._addTradeDays(lastViewedDate, -CONTEXT_DAYS);
                    toDate = await this._addTradeDays(lastViewedDate, FORWARD_DAYS_INITIAL);
                }
            }

            const lookbackDays = this._readLookbackDays();
            // Bars and ranks are fetched serially, not in parallel: a cold
            // /ranks for a never-pre-warmed entry date walks ~lookback_days
            // weekday sessions sequentially server-side (each its own 1s
            // fetch), often 15+ minutes. Painting the chart before ranks
            // finish keeps it interactive while ranks fill in async — same
            // pattern the live prime path uses (_handlePrime → _ensureRanks).
            this._status('Loading bars...');
            const data = await this.api.load(this.currentAsset.symbol, entryDate, fromDate, toDate);
            if (!data.bars.length) {
                this._status(`No data returned for ${this.currentAsset.symbol} ${fromDate}..${toDate}.`);
                this.el.loadBtn.disabled = false;
                return;
            }

            this.chart.setAsset(this.currentAsset);
            this.simulator.setAsset(this.currentAsset);
            // Flush + detach the previous replay session before wiping the
            // simulator: reset() fires onUpdate, and we don't want that to
            // persist an empty trade log over the prior scenario's session.
            this._persistReplaySession();
            this._replaySession = null;
            this._lastPersistedTradeCount = 0;
            this.simulator.reset();
            // Clear stale ranks BEFORE painting the new bars so any rank
            // lookup against the new bars (hover, forming-bar tick) doesn't
            // resolve against the prior asset/timeframe's bucket distribution
            // during the /ranks fetch. _ensureRanks's cache-hit path will
            // re-setData synchronously below; the cache-miss path leaves the
            // engine cleared until the fetch resolves.
            this.rankEngine.clear();

            this.engine.loadInitial({
                bars: data.bars,
                rolls: data.rolls_in_range,
                sessions: data.sessions,
                entryUnix: entryUnix,
                timeframeMin: tf,
            });

            this.currentEntryDate = entryDate;
            this.firstLoadedSession = fromDate;
            this.lastLoadedSession = toDate;
            // Stamp the timeframe onto trades the simulator records, and
            // establish (or resume) the persisted replay session for this
            // asset + entry date.
            this.simulator.timeframeMin = tf;
            // Commit the resume choice made by _peekResumeSession earlier:
            // stamps _replaySession and restores the trade log if resuming.
            this._commitResumeSession(this.currentAsset.symbol, entryDate, tf, resumePeek);
            // If resuming, fast-forward the engine to land on the saved tick.
            // The load window above guarantees lastViewedT is inside the tape.
            if (this._replaySession && this._replaySession.lastViewedT) {
                this.engine.seekTo(this._replaySession.lastViewedT);
            }
            this._refreshWeatherAnchor();

            this.el.loadedSessions.textContent = this.engine.getLoadedSessionCount();
            const _state = this.engine.getCurrentState();
            this.el.tapePos.textContent = `${_state.tapeIndex} / ${_state.tapeLength}`;
            this.el.speedControl.disabled = false;
            this.el.speedPresetApplyBtns.forEach(b => b.disabled = false);
            this.el.loadBtn.disabled = false;

            // Guard: entry is past every loaded bar (typically because the
            // splice anchored on a contract whose data ends before the entry
            // — e.g. an expired front month that never rolled forward). Tell
            // the user what's wrong and don't let them click into a silent
            // dead-end. Ranks fetch is skipped (saves a ~30s round-trip on
            // a load the user can't replay anyway).
            if (_state.tapeIndex >= _state.tapeLength) {
                this.el.playBtn.disabled = true;
                this.el.resetBtn.disabled = true;
                this.el.ghostBtn.disabled = false;
                const ec = data.entry_contract || '(unknown)';
                this._status(
                    `Cannot replay: entry ${entryDate} is past the available data for contract ${ec}. ` +
                    `The loaded tape ends earlier — likely an expired contract whose forward roll didn't fire. ` +
                    `Pick a different entry date.`
                );
                return;
            }

            this.el.playBtn.disabled = false;
            this.el.resetBtn.disabled = false;
            const baseMsg = `Loaded ${this.currentAsset.symbol} ${fromDate} → ${toDate} (entry ${entryDate}, ${data.bars.length} 1s bars, ${data.rolls_in_range.length} rolls).`;
            this._status(`${baseMsg} Ranks loading…`);

            const rankData = await this._ensureRanks(this.currentAsset.symbol, tf, entryDate, lookbackDays);
            if (rankData) {
                this._status(`${baseMsg} Ranks: lookback ${rankData.lookback_days}d, ${rankData.n_sessions_with_data} sessions, ${Object.keys(rankData.buckets).length} buckets.`);
            } else {
                this._status(`${baseMsg} (ranks unavailable)`);
            }
            if (this._ghostEnabled) {
                await this._ensureGhost(this.currentAsset.symbol, tf, entryDate, lookbackDays);
            }
            this.el.ghostBtn.disabled = false;
            // The new (asset, tf, entry, lookback) tuple is now committed on
            // the chart — push it to the rank-compare engine so an enabled
            // panel rebuilds against the new context (and a disabled panel
            // is ready to render the moment the user toggles on).
            this._refreshRankCompareContext();
        } catch (e) {
            console.error(e);
            this._status(`Load failed: ${e.message}`);
            this.el.loadBtn.disabled = false;
        }
    }

    async _prefetchForward() {
        if (!this.currentAsset || !this.lastLoadedSession || !this.currentEntryDate) return;
        try {
            this.el.prefetchStatus.textContent = 'fetching...';
            const fromDate = await this._addTradeDays(this.lastLoadedSession, 1);
            const toDate = await this._addTradeDays(this.lastLoadedSession, FORWARD_DAYS_PREFETCH);
            const data = await this.api.load(this.currentAsset.symbol, this.currentEntryDate, fromDate, toDate);
            const added = this.engine.appendBars({
                bars: data.bars,
                rolls: data.rolls_in_range,
                sessions: data.sessions,
            });
            this.lastLoadedSession = toDate;
            this.el.loadedSessions.textContent = this.engine.getLoadedSessionCount();
            this.el.prefetchStatus.textContent = `+${added || 0} bars (last ${toDate})`;
        } catch (e) {
            console.warn('Prefetch failed:', e);
            this.el.prefetchStatus.textContent = `error: ${e.message}`;
        }
    }

    async _addTradeDays(yyyymmdd, n) {
        // Naive weekday math; backend will gracefully handle holidays.
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

    _play() {
        this.engine.play();
        // Engine bails silently if the playback head is at/past the end of
        // the tape (entry past loaded data, or already played to completion).
        // Detect that directly so the UI doesn't show "Playing" with nothing
        // happening.
        if (!this.engine.getCurrentState().isPlaying) {
            this._status('Nothing to play — the replay position is at/after the end of the loaded data. Pick an earlier entry date or load again.');
            return;
        }
        this.el.playBtn.disabled = true;
        this.el.pauseBtn.disabled = false;
        this.el.buyBtn.disabled = false;
        this.el.sellBtn.disabled = false;
        this.el.flattenBtn.disabled = false;
        this.el.buyStopBtn.disabled = false;
        this.el.sellStopBtn.disabled = false;
        this._status('Playing');
    }
    _pause() {
        this.engine.pause();
        this.el.playBtn.disabled = false;
        this.el.pauseBtn.disabled = true;
        this.el.buyBtn.disabled = true;
        this.el.sellBtn.disabled = true;
        this.el.flattenBtn.disabled = true;
        this.el.buyStopBtn.disabled = true;
        this.el.sellStopBtn.disabled = true;
        this._persistReplaySession();
        this._status('Paused');
    }
    _reset() {
        this.engine.reset();
        // Keep the replay session's cumulative trade log — Reset re-plays the
        // scenario, it doesn't discard your recorded trades. (Use "Clear Log"
        // in the Trade Log modal to start fresh.)
        this.simulator.reset(true);
        this._lastPersistedTradeCount = this.simulator.getCompletedTrades().length;
        this._lastTickT = null;
        this.el.playBtn.disabled = false;
        this.el.pauseBtn.disabled = true;
        this.el.buyBtn.disabled = true;
        this.el.sellBtn.disabled = true;
        this.el.flattenBtn.disabled = true;
        this.el.buyStopBtn.disabled = true;
        this.el.sellStopBtn.disabled = true;
        this._persistReplaySession();
        this._status('Reset — replay restarted (trade log kept)');
        ['currentTime','currentContract','currentOpen','currentHigh','currentLow','currentClose','barVolume','tickTime',
         'volRank','volPendingRank','rangeRank','rangePendingRank',
         'volRankIdx','volPendingRankIdx','rangeRankIdx','rangePendingRankIdx']
            .forEach(k => this.el[k].textContent = '--');
        this.el.dollarRiskDisplay.textContent = 'Risk: --';
        this.el.advPriceDisplay.textContent = '@ --';
        this.el.addQuantityDisplay.textContent = 'Add: --';
    }

    _placeOrder(type) {
        const ready = this.mode === 'replay'
            ? this.engine.getCurrentState().isPlaying
            : this.liveEngine.connected;
        if (!ready) return;
        const qty = this._readQuantity();
        if (qty == null) return;
        const tick = this.activeEngine.getCurrentTick();
        if (!tick) return alert('No current tick available');
        try {
            this.simulator.placeOrder(type, qty, tick.t);
            this._status(`${type.toUpperCase()} ${this._fmtQty(qty)} placed`);
        } catch (e) {
            alert(e.message);
        }
    }

    _flatten() {
        const ready = this.mode === 'replay'
            ? this.engine.getCurrentState().isPlaying
            : this.liveEngine.connected;
        if (!ready) return;
        try {
            this.simulator.flatten();
            this._status('Flatten — orders cancelled, position closing at market');
        } catch (e) {
            alert(e.message);
        }
    }

    _placeStopOrder(type) {
        const ready = this.mode === 'replay'
            ? this.engine.getCurrentState().isPlaying
            : this.liveEngine.connected;
        if (!ready) return;
        const qty = this._readQuantity();
        if (qty == null) return;
        const stopPrice = parseFloat(this.el.stopPriceInput.value);
        if (!Number.isFinite(stopPrice) || stopPrice <= 0) return alert('Enter a valid stop price');
        try {
            const s = this.simulator.placeStopOrder(type, qty, stopPrice);
            const dec = this.currentAsset?.price_decimals ?? 2;
            this._status(`${type.toUpperCase()} STOP ${this._fmtQty(qty)} @ ${s.stopPrice.toFixed(dec)} placed`);
            this.el.stopPriceInput.value = '';
        } catch (e) {
            alert(e.message);
        }
    }

    /** Parse + snap the qty input to the active asset's increment grid.
     *  Returns null and alerts on invalid input. */
    _readQuantity() {
        const inc = this._qtyIncrement();
        const raw = parseFloat(this.el.quantityInput.value);
        if (!Number.isFinite(raw) || raw <= 0) {
            alert(`Quantity must be a positive multiple of ${inc}`);
            return null;
        }
        const snapped = Math.round(raw / inc) * inc;
        if (snapped < inc) {
            alert(`Quantity must be at least ${inc}`);
            return null;
        }
        // Round to 4 decimals to discharge float drift before handing to the
        // simulator's exact multiple-of-increment validator.
        return Math.round(snapped * 10000) / 10000;
    }

    _renderPendingStops(stops) {
        const list = this.el.pendingStopsList;
        const dec = this.currentAsset?.price_decimals ?? 2;
        if (!stops || stops.length === 0) {
            list.replaceChildren();
            list.hidden = true;
            this.chart.setStopOrderLines([]);
            return;
        }
        list.hidden = false;
        const frag = document.createDocumentFragment();
        const label = document.createElement('span');
        label.className = 'pending-stops-label';
        label.textContent = 'Pending stops:';
        frag.appendChild(label);
        for (const s of stops) {
            const chip = document.createElement('span');
            chip.className = `pending-stop-chip ${s.type}`;
            chip.textContent = `${s.type === 'buy' ? 'BUY' : 'SELL'} ${this._fmtQty(s.quantity)} @ ${s.stopPrice.toFixed(dec)} `;
            const cancel = document.createElement('button');
            cancel.className = 'cancel-stop';
            cancel.title = 'Cancel this stop';
            cancel.textContent = '×';
            cancel.addEventListener('click', () => {
                if (this.simulator.cancelStopOrder(s.id)) {
                    this._status(`Stop @ ${s.stopPrice.toFixed(dec)} cancelled`);
                }
            });
            chip.appendChild(cancel);
            frag.appendChild(chip);
        }
        list.replaceChildren(frag);
        this.chart.setStopOrderLines(stops);
    }

    _readLookbackDays() {
        const v = parseInt(this.el.lookbackInput.value, 10);
        if (isNaN(v)) return 365;
        return Math.max(30, Math.min(1095, v));
    }

    _updateRankInfo(bar, currentTickT) {
        if (!bar) return;
        const clearAll = (txt) => {
            ['volRank','volPendingRank','rangeRank','rangePendingRank',
             'volRankIdx','volPendingRankIdx','rangeRankIdx','rangePendingRankIdx']
                .forEach(k => this.el[k].textContent = txt);
        };
        if (!this.rankEngine.hasData()) { clearAll('--'); return; }
        const r = this.rankEngine.forBar(bar, currentTickT);
        if (!r || r.missing) { clearAll(r?.missing ? 'no bucket' : '--'); return; }
        const fmt = (v) => (v == null ? '--' : `${v.toFixed(0)}%`);
        const fmtIdx = (idx) => (idx == null ? '--' : `${idx}/${r.n}`);
        const setPair = (pctEl, idxEl, val, idx) => {
            pctEl.textContent = fmt(val);
            idxEl.textContent = fmtIdx(idx);
            pctEl.classList.toggle('rank-low-n', !!r.lowN);
            idxEl.classList.toggle('rank-low-n', !!r.lowN);
        };
        setPair(this.el.volRank, this.el.volRankIdx, r.volRank, r.volRankIdx);
        setPair(this.el.volPendingRank, this.el.volPendingRankIdx, r.volPendingRank, r.volPendingRankIdx);
        setPair(this.el.rangeRank, this.el.rangeRankIdx, r.rangeRank, r.rangeRankIdx);
        setPair(this.el.rangePendingRank, this.el.rangePendingRankIdx, r.rangePendingRank, r.rangePendingRankIdx);
        // Refresh ⓘ tooltip text so the n + bucket key reflect this hover.
        const suffix = r.lowN ? ` (low n=${r.n})` : ` (n=${r.n}, bucket ${r.bucketKey})`;
        const tips = {
            volRankInfo: "Percentile rank of this bar's volume vs same time-of-day bars over the lookback window. Higher = heavier than typical. Bar's current cumulative value if still forming.",
            volPendingInfo: "Estimated final volume rank using the empirical fractional-volume profile (estimate = current / f(elapsed_fraction)). Shrunk toward historical median in the first 10% of bar.",
            rangeRankInfo: "Percentile rank of this bar's high - low vs same time-of-day bars over the lookback window. Bar's current cumulative range if still forming.",
            rangePendingInfo: "Estimated final range rank using the empirical fractional-range profile. Shrunk toward historical median in the first 10% of bar.",
        };
        for (const [id, base] of Object.entries(tips)) {
            if (this.el[id]) this.el[id].title = base + suffix;
        }
    }

    _updateBarInfo(bar) {
        if (!bar) return;
        const dec = this.currentAsset?.price_decimals ?? 2;
        this.el.currentTime.textContent = formatEt(bar.time, { label: true });
        this.el.currentOpen.textContent = bar.open.toFixed(dec);
        this.el.currentHigh.textContent = bar.high.toFixed(dec);
        this.el.currentLow.textContent = bar.low.toFixed(dec);
        this.el.currentClose.textContent = bar.close.toFixed(dec);
        this.el.barVolume.textContent = (bar.volume || 0).toLocaleString();
        if (bar.contract) this.el.currentContract.textContent = bar.contract;
        this._updateDollarRisk(bar);
    }

    /** Dist % input → number. Empty / non-positive / NaN → 100 (the default,
     *  matches the input's value attribute) so the math is always well-defined. */
    _readDistPct() {
        const v = parseFloat(this.el.distPctInput?.value);
        if (!Number.isFinite(v) || v <= 0) return 100;
        return v;
    }

    /** Dollar Risk: scaled adverse-extreme distance, in ticks + dollars + price.
     *  Base distance is high − close (red bar) or close − low (green bar). The
     *  user's Dist % scales the base tick count, rounded UP to the next whole
     *  tick so the dollar risk never under-counts. stopPrice is the adverse
     *  price implied by the scaled distance — null when ticks === 0 so the UI
     *  shows '--' rather than the close (a 0-tick "risk" is degenerate). */
    _computeDollarRisk(bar) {
        if (!this.currentAsset || !bar) return null;
        const pv = this.currentAsset.point_value;
        const ts = this.currentAsset.tick_size;
        const o = bar.open, h = bar.high, l = bar.low, c = bar.close;
        if (o == null || h == null || l == null || c == null) return null;
        if (!(ts > 0)) return null;
        const isRed = c <= o;
        const baseDistance = isRed ? (h - c) : (c - l);
        const baseTicks = baseDistance / ts;
        const pct = this._readDistPct();
        // ceil(0) === 0, so degenerate bars stay at 0 ticks rather than getting
        // bumped to 1 — preserves the existing "Risk: 0t · $0.00" doji display.
        const ticks = Math.max(0, Math.ceil(baseTicks * pct / 100));
        const distance = ticks * ts;
        const dollars = distance * pv;
        const stopPrice = ticks > 0 ? (isRed ? c + distance : c - distance) : null;
        return { dollars, ticks, stopPrice, isRed };
    }

    /** Add Quantity: view-only sizing for adding to position. Distance is from
     *  the scaled adverse price to the bar's OPPOSITE extreme (low for red,
     *  high for green) — stress-test sizing for "if I entered at adverse and
     *  got stopped at the other side of the bar." At 100% Dist% the adverse
     *  equals the close-side extreme, so addDistance collapses to high − low
     *  (full bar range). Reuses _computeDollarRisk for isRed and ticks but
     *  computes adverse directly so the calc still works when Risk = 0t (close
     *  sitting at the close-side extreme — _computeDollarRisk's stopPrice is
     *  null there, but addDistance = close − low (red) is still meaningful). */
    _computeAddQuantity(bar) {
        const r = this._computeDollarRisk(bar);
        if (!r) return null;
        const ts = this.currentAsset.tick_size;
        const pv = this.currentAsset.point_value;
        const c = bar.close;
        const adverse = r.isRed ? (c + r.ticks * ts) : (c - r.ticks * ts);
        const rawAddDistance = r.isRed ? (adverse - bar.low) : (bar.high - adverse);
        // Snap to tick (no-op on tick-aligned bar data; float-drift safety net).
        const addTicks = Math.max(0, Math.ceil(rawAddDistance / ts));
        if (addTicks === 0) return null;  // doji or fully-degenerate bar
        const addDollars = addTicks * ts * pv;
        const target = parseFloat(this.el.riskTargetInput.value);
        if (!Number.isFinite(target) || target <= 0) return null;  // no target set
        const inc = this._qtyIncrement();
        const raw = target / addDollars;
        return Math.max(inc, Math.floor(raw / inc + 1e-9) * inc);
    }

    _updateDollarRisk(bar) {
        const r = this._computeDollarRisk(bar);
        this._lastRiskValue = r ? r.dollars : null;
        if (!r || !Number.isFinite(r.dollars)) {
            this.el.dollarRiskDisplay.textContent = 'Risk: --';
            this.el.advPriceDisplay.textContent = '@ --';
        } else {
            const fmt = r.dollars >= 1000 ? r.dollars.toFixed(0) : r.dollars.toFixed(2);
            this.el.dollarRiskDisplay.textContent = `Risk: ${r.ticks}t · $${fmt}`;
            if (r.stopPrice == null) {
                this.el.advPriceDisplay.textContent = '@ --';
            } else {
                const dec = this.currentAsset?.price_decimals ?? 2;
                this.el.advPriceDisplay.textContent = `@ ${r.stopPrice.toFixed(dec)}`;
            }
        }
        const addQty = this._computeAddQuantity(bar);
        if (addQty == null) {
            this.el.addQuantityDisplay.textContent = 'Add: --';
        } else {
            this.el.addQuantityDisplay.textContent = `Add: ${addQty.toFixed(this._qtyDecimals())}`;
        }
        this._recalcQuantityFromTarget();
    }

    /** If the user has a "$ Target" set AND the auto-update checkbox is on,
     *  recompute Qty by flooring (target / risk) onto the asset's
     *  min_qty_increment grid. Floors rather than rounds so the dollar risk
     *  never EXCEEDS the user's cap. Auto-off freezes Qty at its current
     *  value so it doesn't drift on the next tick / bar hover. */
    _recalcQuantityFromTarget() {
        if (this.el.riskTargetEnable && !this.el.riskTargetEnable.checked) return;
        const target = parseFloat(this.el.riskTargetInput.value);
        if (!Number.isFinite(target) || target <= 0) return;  // manual qty mode
        const risk = this._lastRiskValue;
        if (!Number.isFinite(risk) || risk <= 0) return;
        const inc = this._qtyIncrement();
        const raw = target / risk;
        // 1e-9 epsilon before floor: raw/inc can land at 19.999999996 for an
        // exact ratio of 20 due to float division (e.g. 2.0 / 0.1). Without
        // this nudge auto-qty would silently undercount by one increment.
        const qty = Math.max(inc, Math.floor(raw / inc + 1e-9) * inc);
        const dec = this._qtyDecimals();
        const snapped = +qty.toFixed(dec);
        if (parseFloat(this.el.quantityInput.value) !== snapped) {
            this.el.quantityInput.value = snapped.toFixed(dec);
        }
    }

    async _clearAllAlerts() {
        try {
            const res = await this.api.clearAlerts();
            await this._refreshAlertList();
            this._status(`Cleared ${res.removed} alert${res.removed === 1 ? '' : 's'}.`);
        } catch (e) {
            console.warn('clear alerts failed:', e);
            this._status(`Clear alerts failed: ${e.message}`);
        }
    }

    /** Switch the chart to the given asset (and optionally timeframe), making
     *  sure live mode is active and the WebSocket subscribes accordingly.
     *  Used when the user clicks an alert chip or notification banner. */
    _switchToAsset(asset, tf) {
        if (this.mode !== 'live') {
            this._setMode('live');
        }
        if (tf && parseInt(this.el.timeframeSelect.value, 10) !== tf) {
            this.el.timeframeSelect.value = String(tf);
        }
        if (this.el.assetSelect.value !== asset) {
            this.el.assetSelect.value = asset;
            try { this.currentAsset = AssetCfg.getAsset(asset); }
            catch (_) { this.currentAsset = null; }
            this._updateTickValue();
        }
        this._connectLive();
    }

    /** Color class for an alert chip based on how close last_value is to
     *  the threshold. Absolute percentage-point distance:
     *    fired (already crossed) → green
     *    within 5pp → red
     *    within 10pp → yellow
     *    further    → no color */
    _alertProximityClass(a) {
        if (a.last_value == null) return '';
        const dist = a.op === '>=' ? a.threshold - a.last_value : a.last_value - a.threshold;
        if (dist <= 0) return 'alert-chip-fired';
        if (dist <= 5) return 'alert-chip-near-red';
        if (dist <= 10) return 'alert-chip-near-yellow';
        return '';
    }

    _updateTradeInfo(state) {
        const dec = this.currentAsset?.price_decimals ?? 2;
        if (state.position > 0) this.el.positionDisplay.textContent = `LONG ${this._fmtQty(state.position)}`;
        else if (state.position < 0) this.el.positionDisplay.textContent = `SHORT ${this._fmtQty(Math.abs(state.position))}`;
        else this.el.positionDisplay.textContent = 'FLAT';
        this.el.avgEntryDisplay.textContent = state.avgEntryPrice > 0 ? state.avgEntryPrice.toFixed(dec) : '--';
        this.el.realizedPnL.textContent = this._fmtPnl(state.realizedPnL);
        this.el.unrealizedPnL.textContent = this._fmtPnl(state.unrealizedPnL);
        this.el.totalPnL.textContent = this._fmtPnl(state.totalPnL);
        this.el.totalPnL.style.color = state.totalPnL > 0 ? '#4caf50' : (state.totalPnL < 0 ? '#f44336' : '#e0e0e0');
    }

    _fmtPnl(v) {
        const sign = v >= 0 ? '+' : '';
        return `${sign}$${v.toFixed(2)}`;
    }

    _status(msg) { this.el.status.textContent = msg; }

    _tfLabel(min) {
        if (!min) return '--';
        const f = TIMEFRAMES.find(t => t.value === min);
        return f ? f.label : `${min}m`;
    }

    _showTradeLog() {
        const trades = this.simulator.getCompletedTrades();
        const dec = this.currentAsset?.price_decimals ?? 2;
        const m = computeMetrics(trades);
        const money = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
        const moneyColor = (v) => (v > 0 ? '#4caf50' : (v < 0 ? '#f44336' : null));
        const has = m.totalTrades > 0;

        const renderGrid = (rows) => rows.map(([label, value, color]) =>
            `<div class="metric-item"><span class="metric-label">${label}</span><span class="metric-value"${color ? ` style="color:${color}"` : ''}>${value}</span></div>`
        ).join('');

        let metricsHtml = '';
        const sess = this._replaySession;
        if (sess) {
            const startedT = sess.startedAt;
            const endT = sess.lastViewedT ?? this._lastTickT;
            const sessionRows = [
                ['Scenario', `${sess.asset} · entry ${sess.entryDate}`],
                ['Session started', startedT ? formatEt(startedT, { label: true }) : '--'],
                ['Current end', endT ? formatEt(endT, { label: true, withSeconds: true }) : '--'],
            ];
            metricsHtml += `<div class="metrics-section-title">Replay Session</div><div class="metrics-grid">${renderGrid(sessionRows)}</div>`;
        }
        const ddTxt = m.ddEpisodeCount
            ? `${m.longestDdTrades} trade${m.longestDdTrades === 1 ? '' : 's'} · ${m.longestDdDays.toFixed(1)}d`
            : '--';
        const perfRows = [
            ['Trades', String(m.totalTrades)],
            ['Win %', has ? `${m.winRate.toFixed(1)}%` : '--'],
            ['Wins / Losses', `${m.winningTrades} / ${m.losingTrades}`],
            ['Total P&L', has ? money(m.totalPnL) : '--', has ? moneyColor(m.totalPnL) : null],
            ['Avg / Trade', has ? money(m.avgPerTrade) : '--', has ? moneyColor(m.avgPerTrade) : null],
            ['Avg Win', m.winningTrades ? money(m.avgWin) : '--', m.winningTrades ? '#4caf50' : null],
            ['Avg Loss', m.losingTrades ? money(m.avgLoss) : '--', m.losingTrades ? '#f44336' : null],
            ['Sortino', m.sortino == null ? '--' : m.sortino.toFixed(2)],
            ['Max DD', has ? `$${m.maxDrawdown.toFixed(2)}` : '--'],
            ['Avg DD', m.ddEpisodeCount ? `$${m.avgDrawdown.toFixed(2)}` : '--'],
            ['Longest DD', ddTxt],
        ];
        metricsHtml += `<div class="metrics-section-title">Performance</div><div class="metrics-grid">${renderGrid(perfRows)}</div>`;
        this.el.tradeMetricsContent.innerHTML = metricsHtml;

        // Cumulative-return chart (collapsible). Build the points now; the
        // chart instance itself is created lazily when the panel is expanded.
        this._equityPoints = equityCurve(trades);
        if (this.el.equityDetails.open) this._ensureEquityChart();
        else if (this._equitySeries) this._equitySeries.setData(this._equityPoints);

        if (trades.length === 0) {
            this.el.tradeLogContent.innerHTML = '<div class="empty-log">No completed trades yet.</div>';
            this.el.downloadCsvBtn.disabled = true;
        } else {
            const rows = trades.map((t, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td>${t.direction}</td>
                    <td>${formatEt(t.entryTime, { label: true })}</td>
                    <td>${t.entryPrice.toFixed(dec)}</td>
                    <td>${formatEt(t.exitTime, { label: true })}</td>
                    <td>${t.exitPrice.toFixed(dec)}</td>
                    <td>${this._fmtQty(t.quantity)}</td>
                    <td>${this._tfLabel(t.timeframeMin)}</td>
                    <td>${t.contract || '--'}</td>
                    <td class="${t.pnl >= 0 ? 'trade-positive' : 'trade-negative'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</td>
                </tr>`).join('');
            this.el.tradeLogContent.innerHTML = `
                <table class="trade-log-table">
                    <thead><tr><th>#</th><th>Direction</th><th>Entry (ET)</th><th>Entry Px</th><th>Exit (ET)</th><th>Exit Px</th><th>Qty</th><th>TF</th><th>Contract</th><th>P&L</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>`;
            this.el.downloadCsvBtn.disabled = false;
        }
        this.el.clearLogBtn.disabled = !sess;
        this.el.tradeLogModal.style.display = 'block';
    }
    _closeTradeLog() { this.el.tradeLogModal.style.display = 'none'; }

    /** Create the lightweight-charts instance for the cumulative-return panel
     *  on first expand (it can't size itself while inside a collapsed
     *  <details>), then load the latest equity points. */
    _ensureEquityChart() {
        if (!this._equityChart && window.LightweightCharts && this.el.equityChart) {
            this._equityChart = LightweightCharts.createChart(this.el.equityChart, {
                autoSize: true,
                layout: { background: { color: '#1a1a1a' }, textColor: '#888', fontSize: 11 },
                grid: { vertLines: { color: '#2a2a2a' }, horzLines: { color: '#2a2a2a' } },
                rightPriceScale: { borderColor: '#444' },
                timeScale: { borderColor: '#444', timeVisible: true, secondsVisible: false },
            });
            this._equitySeries = this._equityChart.addAreaSeries({
                lineColor: '#4a90c2',
                topColor: 'rgba(74, 144, 194, 0.35)',
                bottomColor: 'rgba(74, 144, 194, 0.02)',
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: true,
            });
        }
        if (this._equitySeries) {
            this._equitySeries.setData(this._equityPoints);
            if (this._equityPoints.length) {
                try { this._equityChart.timeScale().fitContent(); } catch (_) {}
            }
        }
    }

    /** Build + download a CSV of every completed trade in the current log. */
    _downloadTradeCsv() {
        const trades = this.simulator.getCompletedTrades();
        if (!trades.length) return;
        const dec = this.currentAsset?.price_decimals ?? 2;
        const sess = this._replaySession;
        const assetTag = sess?.asset ?? (this.currentAsset?.symbol ?? 'replay');
        const dateTag = sess?.entryDate ?? this.currentEntryDate ?? etDateString(Math.floor(Date.now() / 1000));
        const esc = (v) => {
            const s = String(v ?? '');
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const etPlain = (t) => formatEt(t, { label: false }).replace(/ ET$/, '');
        const header = ['#', 'Asset', 'Direction', 'Entry (ET)', 'Entry Price', 'Exit (ET)', 'Exit Price', 'Qty', 'Timeframe', 'Contract', 'P&L ($)'];
        const lines = [header.map(esc).join(',')];
        trades.forEach((t, i) => {
            lines.push([
                i + 1,
                assetTag,
                t.direction,
                etPlain(t.entryTime),
                t.entryPrice.toFixed(dec),
                etPlain(t.exitTime),
                t.exitPrice.toFixed(dec),
                this._fmtQty(t.quantity),
                this._tfLabel(t.timeframeMin),
                t.contract || '',
                t.pnl.toFixed(2),
            ].map(esc).join(','));
        });
        const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `replay_${assetTag}_${dateTag}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    /** Wipe the current replay session's trade log (and its localStorage
     *  entry) and start a fresh one for the same scenario. */
    _clearTradeLog() {
        if (!this._replaySession) return;
        if (!window.confirm('Clear the trade log for this replay session? This deletes the saved session and starts a fresh log.')) return;
        const { asset, entryDate } = this._replaySession;
        // Detach before wiping so simulator.reset()'s onUpdate doesn't persist.
        this._replaySession = null;
        this._lastPersistedTradeCount = 0;
        this.simulator.reset(false);
        ReplayStore.deleteSession(asset, entryDate);
        this._replaySession = {
            asset, entryDate,
            startedAt: Math.floor(Date.now() / 1000),
            lastViewedT: this._lastTickT ?? null,
            lastTimeframeMin: parseInt(this.el.timeframeSelect.value, 10) || 0,
        };
        this._status('Trade log cleared.');
        this._showTradeLog();
    }

    /** Rebuild the Resume dropdown from localStorage. Called on dropdown
     *  mousedown so the list is always current without plumbing notifications
     *  through every save/delete site. */
    _refreshResumeDropdown() {
        const sel = this.el.resumeSessionSelect;
        const sessions = ReplayStore.listSessions();
        const placeholder = sessions.length === 0 ? '— none saved —' : '— select session —';
        const frag = document.createDocumentFragment();
        const opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = placeholder;
        frag.appendChild(opt0);
        for (const s of sessions) {
            const opt = document.createElement('option');
            opt.value = `${s.asset}|${s.entryDate}`;
            opt.dataset.asset = s.asset;
            opt.dataset.entryDate = s.entryDate;
            if (s.lastTimeframeMin) opt.dataset.tf = String(s.lastTimeframeMin);
            const n = s.tradeCount || 0;
            opt.textContent = `${s.asset} · ${s.entryDate} · ${n} trade${n === 1 ? '' : 's'}`;
            frag.appendChild(opt);
        }
        sel.replaceChildren(frag);
    }

    /** Fill Asset / Entry / Timeframe fields from the chosen session and reset
     *  the dropdown to its placeholder. User then clicks Load — the existing
     *  _peekResumeSession resume-confirm path picks up the saved trades. */
    _onResumeSelected() {
        const sel = this.el.resumeSessionSelect;
        const opt = sel.options[sel.selectedIndex];
        if (!opt || !opt.dataset.asset) return;  // placeholder
        const asset = opt.dataset.asset;
        const entryDate = opt.dataset.entryDate;
        const tf = opt.dataset.tf;
        // Validate asset still exists in the current asset list (server may
        // have removed it since this session was saved).
        const assetOk = Array.from(this.el.assetSelect.options).some(o => o.value === asset);
        if (!assetOk) {
            alert(`Asset "${asset}" is no longer available — can't restore this session.`);
            sel.selectedIndex = 0;
            return;
        }
        this.el.assetSelect.value = asset;
        try { this.currentAsset = AssetCfg.getAsset(asset); }
        catch (_) { this.currentAsset = null; }
        this._updateTickValue();
        // Use 09:30 ET on the saved trade date as a sensible default entry time.
        // The trade-date resolver on Load will round back to entryDate; the
        // existing resume-confirm popup then prompts to restore the trade log.
        this.el.entryDate.value = `${entryDate}T09:30`;
        if (tf) {
            const tfOk = Array.from(this.el.timeframeSelect.options).some(o => o.value === tf);
            if (tfOk) this.el.timeframeSelect.value = tf;
        }
        this.el.loadBtn.disabled = !this.currentAsset;
        sel.selectedIndex = 0;
        this._status(`Resume queued: ${asset} ${entryDate} — click Load.`);
    }

    /** Look up a saved replay session and (if it has trades) prompt the user
     *  to resume. Returns { saved, resume } — `saved` is the raw payload (or
     *  null) and `resume` is the user's choice. Pure peek: no state mutation,
     *  no simulator changes. Called from _load BEFORE the bars fetch so the
     *  load window can be sized based on the resume choice — a resumed session
     *  with a far-future lastViewedT loads a small slice around lastViewedT
     *  instead of pulling months of contiguous data from the original entry. */
    _peekResumeSession(asset, entryDate) {
        const saved = ReplayStore.loadSession(asset, entryDate);
        let resume = false;
        if (saved && Array.isArray(saved.trades) && saved.trades.length > 0) {
            const started = saved.startedAt ? formatEt(saved.startedAt, { label: true }) : '(unknown)';
            const lastViewed = saved.lastViewedT ? formatEt(saved.lastViewedT, { label: true, withSeconds: true }) : '(none)';
            const n = saved.trades.length;
            const msg = `Found a saved replay session for ${asset} entry ${entryDate}:\n`
                + `  • ${n} trade${n === 1 ? '' : 's'} logged\n`
                + `  • session started: ${started}\n`
                + `  • last viewed: ${lastViewed}\n\n`
                + `Resume it (keep accumulating into this log)?\n`
                + `Cancel = start a fresh log (the saved one is kept until you make a new trade).`;
            resume = window.confirm(msg);
        }
        return { saved, resume };
    }

    /** Commit the resume choice after bars are loaded: stamp _replaySession
     *  and (if resuming) restore the trade log onto the simulator. */
    _commitResumeSession(asset, entryDate, tf, { saved, resume }) {
        this._replaySession = {
            asset,
            entryDate,
            startedAt: (resume && saved && saved.startedAt) ? saved.startedAt : Math.floor(Date.now() / 1000),
            lastViewedT: (resume && saved) ? (saved.lastViewedT ?? null) : null,
            lastTimeframeMin: tf,
        };
        if (resume && saved) {
            this.simulator.restoreTrades(saved.trades);
        }
        this._lastPersistedTradeCount = this.simulator.getCompletedTrades().length;
    }

    /** Persist the active replay session to localStorage. No-op if there's no
     *  active session or nothing worth saving yet. */
    _persistReplaySession() {
        const sess = this._replaySession;
        if (!sess || !sess.asset || !sess.entryDate) return;
        const trades = this.simulator.getCompletedTrades();
        if (trades.length === 0 && sess.lastViewedT == null) return;
        ReplayStore.saveSession(sess.asset, sess.entryDate, {
            startedAt: sess.startedAt,
            lastViewedT: sess.lastViewedT,
            lastTimeframeMin: parseInt(this.el.timeframeSelect.value, 10) || sess.lastTimeframeMin || null,
            trades,
        });
    }

    async _saveAlert() {
        const cfg = {
            asset: this.el.alertAsset.value,
            metric: this.el.alertMetric.value,
            op: this.el.alertOp.value,
            threshold: parseFloat(this.el.alertThreshold.value),
            tf: parseInt(this.el.alertTimeframe.value, 10),
            lookback: this._readLookbackDays(),
        };
        if (!cfg.asset || !Number.isFinite(cfg.threshold)) return;
        // Warm up the audio context now (we're on a user-gesture handler) so
        // future alert beeps don't get blocked by autoplay policies.
        this._ensureAudioCtx();
        try {
            if (cfg.asset === '*') {
                // Fan out one POST per asset — each alert is independent and
                // removable from its own chip.
                const symbols = Array.from(this.el.assetSelect.options).map(o => o.value);
                await Promise.all(symbols.map(sym => this.api.createAlert({ ...cfg, asset: sym })));
                await this._refreshAlertList();
                this._status(`Alerts saved for all ${symbols.length} assets: ${this._metricLabel(cfg.metric)} ${cfg.op} ${cfg.threshold}% on ${cfg.tf}m`);
            } else {
                await this.api.createAlert(cfg);
                await this._refreshAlertList();
                this._status(`Alert saved: ${cfg.asset} ${this._metricLabel(cfg.metric)} ${cfg.op} ${cfg.threshold}% on ${cfg.tf}m`);
            }
        } catch (e) {
            console.warn('alert save failed:', e);
            this._status(`Alert save failed: ${e.message}`);
        }
    }

    async _refreshAlertList() {
        let resp;
        try { resp = await this.api.listAlerts(); }
        catch (_) { return; }
        this.el.alertList.replaceChildren();
        const tfLabel = (m) => {
            const t = TIMEFRAMES.find(x => x.value === m);
            return t ? t.label : `${m}m`;
        };
        const alerts = resp.alerts || [];
        for (const a of alerts) {
            const chip = document.createElement('span');
            chip.className = 'alert-chip';
            const proxClass = this._alertProximityClass(a);
            if (proxClass) chip.classList.add(proxClass);
            // Show the latest evaluated value so user can confirm "armed and
            // evaluating, just hasn't crossed yet" vs. "silently broken".
            const valuePart = a.last_value != null ? ` @${a.last_value}%` : '';
            const firePart = a.fire_count > 0 ? ` ×${a.fire_count}` : '';
            chip.textContent = `${a.asset} ${this._metricLabel(a.metric)} ${a.op} ${a.threshold}% ${tfLabel(a.tf)}${valuePart}${firePart} `;
            chip.title = (a.last_eval_time
                ? `Last evaluated: ${new Date(a.last_eval_time * 1000).toLocaleTimeString()}` +
                  (a.last_fired_time ? `\nLast fired: ${new Date(a.last_fired_time * 1000).toLocaleTimeString()}` : '')
                : 'Not yet evaluated (waiting for next 1s bar)') +
                '\nClick to switch chart to this asset/timeframe.';
            chip.addEventListener('click', (e) => {
                if (e.target.classList.contains('alert-chip-remove')) return;
                this._switchToAsset(a.asset, a.tf);
            });
            const x = document.createElement('span');
            x.className = 'alert-chip-remove';
            x.textContent = '×';
            x.title = 'Remove alert';
            x.addEventListener('click', async (e) => {
                e.stopPropagation();
                try { await this.api.deleteAlert(a.id); }
                catch (e) { console.warn(e); }
                this._refreshAlertList();
            });
            chip.appendChild(x);
            this.el.alertList.appendChild(chip);
        }
        // Poll while there are alerts so chips show live last_value updates.
        if (alerts.length > 0) {
            if (!this._alertPollTimer) {
                this._alertPollTimer = setInterval(() => this._refreshAlertList(), 5000);
            }
        } else if (this._alertPollTimer) {
            clearInterval(this._alertPollTimer);
            this._alertPollTimer = null;
        }
    }

    _metricLabel(metric) {
        return ({
            vol: 'Vol Rank',
            vol_pending: 'Vol Pending',
            range: 'Range Rank',
            range_pending: 'Range Pending',
        })[metric] || metric;
    }

    _onAlertFired(msg) {
        const tfLabel = (m) => {
            const t = TIMEFRAMES.find(x => x.value === m);
            return t ? t.label : `${m}m`;
        };
        const text = `ALERT — ${msg.asset} ${this._metricLabel(msg.metric)} ${msg.op} ${msg.threshold}% — value ${msg.value}% (${tfLabel(msg.tf)} bar ${msg.bucket_key} ET)`;

        // Add a persistent notification banner at top of the screen. Each
        // banner stays for 30s, then fades out. Multiple alerts stack
        // newest-on-top. User can dismiss any banner with × at any time.
        const banner = document.createElement('div');
        banner.className = 'alert-notification';
        banner.style.cursor = 'pointer';
        banner.title = 'Click to switch chart to this asset/timeframe';
        const textNode = document.createElement('span');
        textNode.className = 'alert-notification-text';
        textNode.textContent = text;
        const dismiss = document.createElement('span');
        dismiss.className = 'alert-notification-dismiss';
        dismiss.textContent = '×';
        dismiss.title = 'Dismiss';
        const remove = () => {
            if (banner.parentNode) {
                banner.classList.add('dismissing');
                setTimeout(() => { if (banner.parentNode) banner.remove(); }, 250);
            }
        };
        dismiss.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
        banner.addEventListener('click', () => {
            this._switchToAsset(msg.asset, msg.tf);
            remove();
        });
        banner.append(textNode, dismiss);
        this.el.alertNotifications.prepend(banner);
        setTimeout(remove, 30000);

        this._status(text);
        // Pick the tone for this metric's group and only play if not muted.
        // Banner above is unconditional — only the audio is gated.
        const group = this._metricGroup(msg.metric);
        const muted = (group === 'pending')
            ? this.el.mutePendingAlerts?.checked
            : this.el.muteRankAlerts?.checked;
        if (!muted) {
            if (group === 'pending') this._playPendingBeep();
            else this._playRankBeep();
        }
        // Refresh the alert chips so fire_count updates immediately.
        this._refreshAlertList();
    }

    _ensureAudioCtx() {
        try {
            if (!this._audioCtx) {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return null;
                this._audioCtx = new Ctx();
            }
            // Browsers suspend the AudioContext when created without a user
            // gesture; resume on every user click that might soon want to
            // beep, so the actual beep doesn't drop silently.
            if (this._audioCtx.state === 'suspended') {
                this._audioCtx.resume();
            }
            return this._audioCtx;
        } catch (e) {
            return null;
        }
    }

    /** Whether a metric belongs to the "pending" group (estimated final
     *  values) or the "rank" group (absolute, no estimation). */
    _metricGroup(metric) {
        return (metric === 'vol_pending' || metric === 'range_pending')
            ? 'pending' : 'rank';
    }

    /** Play one tone at the given frequency. Shared envelope so both alert
     *  styles have similar perceived loudness. */
    _playTone(freq, startOffset = 0, duration = 0.18) {
        const ctx = this._ensureAudioCtx();
        if (!ctx) return;
        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = freq;
            osc.type = 'sine';
            gain.gain.value = 0.20;
            osc.connect(gain).connect(ctx.destination);
            const t0 = ctx.currentTime + startOffset;
            osc.start(t0);
            gain.gain.setValueAtTime(0.20, t0 + duration);
            gain.gain.linearRampToValueAtTime(0.0, t0 + duration + 0.10);
            osc.stop(t0 + duration + 0.12);
        } catch (e) { /* audio unavailable; silent */ }
    }

    /** Single 880 Hz tone — used for "pending" alerts (vol_pending,
     *  range_pending). Same sound the original implementation used. */
    _playPendingBeep() { this._playTone(880, 0, 0.18); }

    /** Two-tone 660 → 990 Hz — used for "rank" alerts (vol, range). The
     *  ascending interval is recognizably distinct from the single tone
     *  without being intrusive. */
    _playRankBeep() {
        this._playTone(660, 0,    0.10);
        this._playTone(990, 0.13, 0.15);
    }

    /** Cached rank fetch: hit the in-memory map first; otherwise fetch from
     *  /ranks and store. Server-side already disk-caches per (asset,tf,entry,
     *  lookback), so first-fetch is the only slow path; switching back to a
     *  previously-seen timeframe is instantaneous.
     *
     *  Generation guard: rapid switches (A → B → A) can have multiple
     *  _ensureRanks calls in flight. Without a guard, an earlier call's
     *  setData could resolve LAST and overwrite the latest correct target.
     *  We bump _rankGen on every call and only setData if the call's gen is
     *  still the current one. */
    async _ensureRanks(asset, tf, entry, lookback) {
        const key = `${asset}|${tf}|${entry}|${lookback}`;
        const myGen = ++this._rankGen;
        const cached = this._rankCache.get(key);
        if (cached) {
            if (myGen === this._rankGen) this.rankEngine.setData(cached);
            return cached;
        }
        // Cache miss — old rank data is for the wrong asset/timeframe and
        // would mislead, so clear before fetching. Callers should also clear
        // before swapping the displayed bars to close the race window.
        this.rankEngine.clear();
        try {
            const data = await this.api.ranks(asset, tf, entry, lookback);
            if (data && myGen === this._rankGen) {
                this._rankCache.set(key, data);
                this.rankEngine.setData(data);
            }
            return data;
        } catch (e) {
            console.warn('ranks fetch failed:', e);
            return null;
        }
    }

    /** Mirror of _ensureRanks for the /ghost payload. Same generation guard
     *  protects against late-resolving fetches overwriting the latest. The
     *  data is loaded into this.ghostEngine; the chart is then asked to
     *  refresh by re-running its ghost-recompute path against the bars it
     *  currently holds.
     *
     *  Cache key includes the filter params (percentile / dow / wom) so each
     *  combo has its own slot. Anchor mode is render-side and not part of
     *  the payload — toggling Session ↔ Realtime doesn't refetch. */
    async _ensureGhost(asset, tf, entry, lookback) {
        const cfg = this._ghostConfig;
        const key = `${asset}|${tf}|${entry}|${lookback}|p=${cfg.percentile}|dow=${cfg.dowFilter}|wom=${cfg.womFilter}`;
        const myGen = ++this._ghostGen;
        const cached = this._ghostCache.get(key);
        if (cached) {
            if (myGen === this._ghostGen) {
                this.ghostEngine.setData(cached);
                this._repaintGhostOverlay();
            }
            return cached;
        }
        this.ghostEngine.clear();
        if (this._ghostEnabled && this.el.ghostBtn) {
            this.el.ghostBtn.textContent = 'Ghost: Loading…';
            this.el.ghostBtn.classList.add('loading');
        }
        try {
            const data = await this.api.ghost(asset, tf, entry, lookback, {
                percentile: cfg.percentile,
                dowFilter: cfg.dowFilter !== '' ? parseInt(cfg.dowFilter, 10) : null,
                womFilter: cfg.womFilter !== '' ? parseInt(cfg.womFilter, 10) : null,
            });
            if (data && myGen === this._ghostGen) {
                this._ghostCache.set(key, data);
                this.ghostEngine.setData(data);
                this._repaintGhostOverlay();
            }
            return data;
        } catch (e) {
            console.warn('ghost fetch failed:', e);
            return null;
        } finally {
            if (myGen === this._ghostGen && this._ghostEnabled && this.el.ghostBtn) {
                this.el.ghostBtn.textContent = 'Ghost: On';
                this.el.ghostBtn.classList.remove('loading');
            }
        }
    }

    /** Refetch ghost when ghost is enabled and the user has data loaded.
     *  No-op otherwise. Called from each filter/percentile select change. */
    _refetchGhostIfActive() {
        if (!this._ghostEnabled) return;
        if (!this.currentAsset || !this.currentEntryDate) return;
        if (this.mode !== 'replay') return;
        const tf = parseInt(this.el.timeframeSelect.value, 10);
        this._ensureGhost(this.currentAsset.symbol, tf,
                          this.currentEntryDate, this._readLookbackDays());
    }

    /** Push the current anchor-mode config to the engine + chart and force
     *  a recompute. No fetch — anchor is purely a render-time choice. */
    _applyGhostAnchor() {
        const isRealtime = this._ghostConfig.anchor === 'realtime';
        this.ghostEngine.setMode(isRealtime ? 'realtime' : 'session');
        this.chart.setGhostRealtimeMode(isRealtime);
        if (this._ghostEnabled) {
            this._repaintGhostOverlay();
        }
    }

    /** Trigger a ghost-overlay redraw using the bars currently on the chart.
     *  ChartController owns the snapshot, so this is a one-liner. */
    _repaintGhostOverlay() {
        if (this.mode !== 'replay') return;
        this.chart.refreshGhostOverlay();
    }

    _toggleGhost() {
        this._ghostEnabled = !this._ghostEnabled;
        this.el.ghostBtn.textContent = `Ghost: ${this._ghostEnabled ? 'On' : 'Off'}`;
        this.el.ghostBtn.classList.toggle('active', this._ghostEnabled);
        if (this.el.ghostConfigGroup) this.el.ghostConfigGroup.hidden = !this._ghostEnabled;
        if (this._ghostEnabled) {
            // Seed engine with the current timeframe (enables forward
            // projection) and the current anchor mode.
            const tf = parseInt(this.el.timeframeSelect.value, 10);
            this.ghostEngine.setTimeframeMin(Number.isFinite(tf) ? tf : 0);
            this._applyGhostAnchor();
            this.chart.setGhostEngine(this.ghostEngine);
            if (this.currentAsset && this.currentEntryDate && this.mode === 'replay') {
                this._ensureGhost(this.currentAsset.symbol, tf,
                                  this.currentEntryDate, this._readLookbackDays());
            }
        } else {
            this.chart.setGhostEngine(null);
            this.chart.setGhostRealtimeMode(false);
            this.ghostEngine.clear();
            this._updateGhostInfo(null);
        }
    }

    _toggleWeather() {
        if (!this.weather) return;
        const next = !this.weather.enabled;
        this.weather.setEnabled(next);
        this.el.weatherToggleBtn.textContent = `Weather: ${next ? 'On' : 'Off'}`;
        this.el.weatherToggleBtn.classList.toggle('active', next);
        // Set anchor: replay = currentEntryDate (the loaded entry session),
        // live = today (server side will use ingestion-date == today anyway).
        if (next) {
            this._refreshWeatherAnchor();
        }
    }

    /** Replay-only. The engine itself silently no-ops if context isn't set
     *  yet, but we also block toggling on in live mode at the button level
     *  (matches the ghost-mode pattern). */
    _toggleRankCompare() {
        if (!this.rankCompare) return;
        if (this.mode !== 'replay') return;
        const next = !this.rankCompare.enabled;
        this.rankCompare.setEnabled(next);
        this.el.rankCompareBtn.textContent = `Rank Compare: ${next ? 'On' : 'Off'}`;
        this.el.rankCompareBtn.classList.toggle('active', next);
    }

    /** Trend-status panel toggle. Works in both replay and live — it only
     *  needs the chart's candle array, which both modes populate. */
    _toggleTrendStatus() {
        if (!this.trendStatus) return;
        const next = !this.trendStatus.enabled;
        this.trendStatus.setEnabled(next);
        this.el.trendStatusBtn.textContent = `Trend: ${next ? 'On' : 'Off'}`;
        this.el.trendStatusBtn.classList.toggle('active', next);
    }

    /** Push the current loaded-replay context into the rank-compare engine.
     *  No-op when not in replay mode or before any /load has succeeded.
     *  Safe to call even when the panel is toggled off — the engine just
     *  records the context and uses it on the next toggle-on.
     *
     *  Critically: pass our actual loaded window. On a resumed session
     *  main.js's _load shifts fromDate/toDate forward to center on
     *  lastViewedT — if we don't tell the rank-compare engine, its tapes
     *  cover entry-date times that don't overlap the chart, and every
     *  hover renders as "—". */
    _refreshRankCompareContext() {
        if (!this.rankCompare) return;
        if (this.mode !== 'replay') return;
        if (!this.currentAsset || !this.currentEntryDate) return;
        const tf = parseInt(this.el.timeframeSelect.value, 10);
        if (!Number.isFinite(tf)) return;
        this.rankCompare.setContext({
            asset: this.currentAsset.symbol,
            timeframeMin: tf,
            entryDate: this.currentEntryDate,
            lookbackDays: this._readLookbackDays(),
            fromDate: this.firstLoadedSession,
            toDate: this.lastLoadedSession,
        });
    }

    /** Pick the right anchor date for the current mode/state. Called when
     *  the user toggles weather on, when mode changes, when a new replay
     *  session loads, or when the live entry session is established. */
    _refreshWeatherAnchor() {
        if (!this.weather) return;
        let anchor = null;
        if (this.mode === 'replay') {
            anchor = this.currentEntryDate || null;
        } else {
            // Live: anchor is today's UTC date — server treats this as the
            // current vintage for ingestion. (UTC instead of ET because the
            // backend ingestion job uses UTC; matching avoids one-day drift
            // around 0Z.)
            anchor = new Date().toISOString().slice(0, 10);
        }
        if (anchor) this.weather.setAnchor(anchor);
    }

    _renderContractSplitFlag(contracts) {
        const el = this.el.contractSplitFlag;
        if (!el) return;
        if (contracts && contracts.length >= 2) {
            el.textContent = `⚑ Data from ${contracts.length} contracts on chart`;
            el.title = contracts.join(' → ');
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    }

    _updateGhostInfo(ghost) {
        if (!this.el.ghostInfoItem || !this.el.ghostInfo) return;
        if (!this._ghostEnabled || !ghost) {
            this.el.ghostInfoItem.hidden = true;
            this.el.ghostInfo.textContent = '--';
            return;
        }
        const pctBlue = (ghost.pctBlue * 100).toFixed(0);
        const pctGray = (ghost.pctGray * 100).toFixed(0);
        const colorTag = ghost.color === 'blue' ? 'blue' : 'gray';
        const vol = (ghost.volume ?? 0);
        const volTxt = vol >= 1 ? Math.round(vol).toLocaleString() : '0';
        this.el.ghostInfoItem.hidden = false;
        this.el.ghostInfo.textContent = `${colorTag} · ${pctBlue}% blue / ${pctGray}% gray · vol=${volTxt} · n=${ghost.n}`;
    }

    /** Poll /live_status and surface warm-up state in two places:
     *    1. asset-dropdown labels — show per-asset readiness ("rank queued",
     *       "rank loading", "unavailable: ...") so the user knows which
     *       contracts are actually ready to Connect.
     *    2. header pill — overall progress ("Pre-warming ranks: 7/15 — HO")
     *       so there's a single, consistent "still loading" cue.
     *
     *  Two warmup phases:
     *    Phase 1 (live subscribe) — fast, seconds. Tracked in warmup_status.
     *    Phase 2 (rank pre-warm)  — slow, minutes on cold cache. Tracked in
     *                               rank_prewarm.per_asset + done/total.
     *
     *  The poll cadence (3s) continues until BOTH phases complete; previously
     *  it stopped at phase-1-ready, leaving the user with no signal during
     *  the multi-minute phase 2. */
    async _refreshLiveStatus() {
        let st;
        try { st = await this.api.liveStatus(); }
        catch (_) { return; }
        const phase1 = st.warmup_status || {};
        const rank = st.rank_prewarm || {};
        const rankPer = rank.per_asset || {};
        const opts = this.el.assetSelect.options;
        for (let i = 0; i < opts.length; i++) {
            const sym = opts[i].value;
            const base = opts[i].dataset.baseLabel || opts[i].textContent;
            opts[i].dataset.baseLabel = base;
            const ws = phase1[sym];
            const rs = rankPer[sym];
            let suffix = '';
            if (ws === undefined) suffix = ' (live warming)';
            else if (ws !== 'ok') suffix = ` (unavailable: ${ws})`;
            else if (rs === 'pending') suffix = ' (rank queued)';
            else if (rs === 'current') suffix = ' (rank loading)';
            else if (rs === 'failed') suffix = ' (rank failed)';
            opts[i].textContent = base + suffix;
        }
        const pill = this.el.warmupPill;
        if (pill) {
            if (!st.ready) {
                pill.hidden = false;
                pill.textContent = 'Connecting live feed…';
            } else if (rank.complete === false) {
                const cur = rank.current ? ` — ${rank.current}` : '';
                pill.textContent = `Pre-warming ranks: ${rank.done ?? 0}/${rank.total ?? 0}${cur}`;
                pill.hidden = false;
            } else {
                pill.hidden = true;
                pill.textContent = '';
            }
        }
        if (this._liveStatusPollTimer) {
            clearTimeout(this._liveStatusPollTimer);
            this._liveStatusPollTimer = null;
        }
        const allDone = st.ready && rank.complete === true;
        if (!allDone) {
            this._liveStatusPollTimer = setTimeout(() => this._refreshLiveStatus(), 3000);
        }
    }

    _updateTickValue() {
        if (!this.currentAsset) {
            this.el.tickValueDisplay.textContent = '--/tick';
            return;
        }
        const v = this.currentAsset.tick_size * this.currentAsset.point_value;
        let fmt;
        if (v >= 100) fmt = v.toFixed(0);
        else if (v >= 1) fmt = v.toFixed(2);
        else fmt = v.toFixed(4);
        this.el.tickValueDisplay.textContent = `$${fmt}/tick`;
        this._syncQuantityIncrement();
    }

    /** Reflect the asset's min_qty_increment into the quantity <input>'s step
     *  and min, and snap any existing value onto the new grid so a switch
     *  from NQ (0.1) → SI (0.2) doesn't leave 0.5 (invalid for SI) sitting
     *  in the box. */
    _syncQuantityIncrement() {
        const inc = this._qtyIncrement();
        const dec = this._qtyDecimals();
        this.el.quantityInput.step = String(inc);
        this.el.quantityInput.min = String(inc);
        const cur = parseFloat(this.el.quantityInput.value);
        const snapped = Number.isFinite(cur) && cur > 0
            ? Math.max(inc, Math.round(cur / inc) * inc)
            : inc;
        this.el.quantityInput.value = snapped.toFixed(dec);
    }

    _qtyIncrement() { return this.currentAsset?.min_qty_increment ?? 1; }
    _qtyDecimals() {
        const inc = this._qtyIncrement();
        return inc >= 1 ? 0 : inc >= 0.1 ? 1 : 2;
    }
    _fmtQty(q) { return q.toFixed(this._qtyDecimals()); }

    _setMode(mode, force = false) {
        if (!force && mode === this.mode) return;
        // Leaving replay (or re-initializing): flush + detach the active
        // session so the simulator.reset() below — and any live-mode trades —
        // don't write into it.
        if (this.mode === 'replay') this._persistReplaySession();
        this._replaySession = null;
        this._lastPersistedTradeCount = 0;
        this.mode = mode;
        // sessionStorage (NOT localStorage) so two tabs can hold different
        // modes simultaneously. Each tab still remembers its mode across
        // reloads of that tab.
        try { sessionStorage.setItem('tradeChart.mode', mode); } catch (_) {}
        this.el.modeReplayBtn.classList.toggle('active', mode === 'replay');
        this.el.modeLiveBtn.classList.toggle('active', mode === 'live');
        this._refreshWeatherAnchor();

        // Always tear down anything mode-specific from the prior state.
        try { this.engine.pause(); } catch (_) {}
        this._disconnectLive(false);
        this.simulator.reset();
        this._lastTickT = null;
        ['currentTime','currentContract','currentOpen','currentHigh','currentLow',
         'currentClose','barVolume','tickTime',
         'volRank','volPendingRank','rangeRank','rangePendingRank',
         'volRankIdx','volPendingRankIdx','rangeRankIdx','rangePendingRankIdx']
            .forEach(k => { if (this.el[k]) this.el[k].textContent = '--'; });
        if (this.el.dollarRiskDisplay) this.el.dollarRiskDisplay.textContent = 'Risk: --';
        if (this.el.advPriceDisplay) this.el.advPriceDisplay.textContent = '@ --';
        if (this.el.addQuantityDisplay) this.el.addQuantityDisplay.textContent = 'Add: --';
        this.el.loadedSessions.textContent = '0';
        this.el.tapePos.textContent = '0 / 0';
        this.el.prefetchStatus.textContent = 'idle';
        if (this.chart && this.chart.clear) this.chart.clear();

        // Alert config UI is a live-mode feature (server-side alerts evaluate
        // against the live tick stream). Hide the whole block in replay so the
        // mode row is uncluttered. Notification banners are NOT touched —
        // they're driven by the persistent WS and remain available across
        // modes by the same design that keeps the WS open in replay.
        if (this.el.alertsSection) {
            this.el.alertsSection.style.display = mode === 'live' ? 'contents' : 'none';
        }

        if (mode === 'live') {
            this.activeEngine = this.liveEngine;
            this.el.entryDate.style.display = 'none';
            if (this.el.entryDateLabel) this.el.entryDateLabel.style.display = 'none';
            if (this.el.resumeLabel) this.el.resumeLabel.style.display = 'none';
            if (this.el.resumeSessionSelect) this.el.resumeSessionSelect.style.display = 'none';
            this.el.playbackControlsRow.style.display = 'none';
            this.el.loadBtn.style.display = 'none';
            this.el.connectBtn.style.display = '';
            this.el.disconnectBtn.style.display = '';
            this.el.connectBtn.disabled = !this.currentAsset;
            this.el.disconnectBtn.disabled = true;
            this.el.playBtn.disabled = true;
            this.el.pauseBtn.disabled = true;
            this.el.resetBtn.disabled = true;
            this.el.buyBtn.disabled = true;
            this.el.sellBtn.disabled = true;
            this.el.flattenBtn.disabled = true;
            this.el.buyStopBtn.disabled = true;
            this.el.sellStopBtn.disabled = true;
            // Ghost mode is replay-only — force off and hide the toggle + config.
            if (this._ghostEnabled) this._toggleGhost();
            if (this.el.ghostBtn) this.el.ghostBtn.style.display = 'none';
            if (this.el.ghostInfoItem) this.el.ghostInfoItem.hidden = true;
            if (this.el.ghostConfigGroup) this.el.ghostConfigGroup.hidden = true;
            // Rank-compare is replay-only too — force off and disable the
            // button so it can't be toggled until the user comes back to
            // replay mode.
            if (this.rankCompare && this.rankCompare.enabled) {
                this.rankCompare.setEnabled(false);
                this.el.rankCompareBtn.textContent = 'Rank Compare: Off';
                this.el.rankCompareBtn.classList.remove('active');
            }
            if (this.el.rankCompareBtn) this.el.rankCompareBtn.disabled = true;
            this._status('Live mode. Pick asset, click Connect.');
        } else {
            this.activeEngine = this.engine;
            this.el.entryDate.style.display = '';
            if (this.el.entryDateLabel) this.el.entryDateLabel.style.display = '';
            if (this.el.resumeLabel) this.el.resumeLabel.style.display = '';
            if (this.el.resumeSessionSelect) this.el.resumeSessionSelect.style.display = '';
            this.el.playbackControlsRow.style.display = '';
            this.el.loadBtn.style.display = '';
            this.el.connectBtn.style.display = 'none';
            this.el.disconnectBtn.style.display = 'none';
            this.el.loadBtn.disabled = !this.currentAsset;
            this.el.playBtn.disabled = true;
            this.el.pauseBtn.disabled = true;
            this.el.resetBtn.disabled = true;
            this.el.buyBtn.disabled = true;
            this.el.sellBtn.disabled = true;
            this.el.flattenBtn.disabled = true;
            this.el.buyStopBtn.disabled = true;
            this.el.sellStopBtn.disabled = true;
            if (this.el.ghostBtn) {
                this.el.ghostBtn.style.display = '';
                // Disabled until first /load completes; toggling without bars
                // would just show "ghost on" with no overlay.
                this.el.ghostBtn.disabled = !this.currentEntryDate;
            }
            // Rank-compare button is always present; just re-enable it now
            // that we're back in replay. Engine stays off until user toggles.
            if (this.el.rankCompareBtn) this.el.rankCompareBtn.disabled = false;
            this._status('Replay mode. Pick asset, entry datetime (ET), timeframe, then Load.');
        }
    }

    /** Open the persistent live WebSocket. Reconnects automatically on drop.
     *  This stays open across mode toggles so alert messages keep flowing
     *  even when the user is in Replay mode or hasn't clicked Connect. */
    _setupWs() {
        if (this._liveWs && this._liveWs.readyState <= WebSocket.OPEN) return;
        const ws = this.api.openLive();
        this._liveWs = ws;

        ws.onopen = () => {
            // If the user had previously subscribed to an asset (and a drop
            // forced a reconnect), automatically re-subscribe so live data
            // resumes without manual intervention.
            if (this.mode === 'live' && this._wantsLiveAsset) {
                ws.send(JSON.stringify({ op: 'subscribe', asset: this._wantsLiveAsset }));
            }
        };

        ws.onmessage = async (event) => {
            let msg;
            try { msg = JSON.parse(event.data); }
            catch (e) { console.warn('bad ws msg:', event.data); return; }
            if (msg.type === 'prime') {
                await this._handlePrime(msg.payload);
            } else if (msg.type === 'bar') {
                // Drop bars that belong to a prior subscription. After
                // switching NG → CL, NG bars in flight (or flushed from
                // NG's bar_history) would otherwise be painted onto a
                // CL-configured chart. Server tags every bar payload with
                // its asset; older servers without the tag fall through
                // unchanged.
                if (msg.asset && msg.asset !== this._wantsLiveAsset) return;
                // Only render bars while the user is actually viewing the live
                // engine — otherwise a stray subscription or race could push
                // bars onto a hidden engine and corrupt the chart.
                if (this.mode === 'live' && this.liveEngine.connected) {
                    this.liveEngine.onLiveBar(msg.bar, !!msg.final);
                }
            } else if (msg.type === 'status') {
                this._status(`Live: ${msg.message}`);
            } else if (msg.type === 'error') {
                console.warn('live error:', msg.message);
                this._status(`Live error: ${msg.message}`);
            } else if (msg.type === 'alert') {
                this._onAlertFired(msg);
            }
        };

        ws.onerror = (e) => { console.warn('ws error', e); };

        ws.onclose = () => {
            if (this._liveWs === ws) this._liveWs = null;
            this.liveEngine.connected = false;
            if (this.mode === 'live') {
                this.el.disconnectBtn.disabled = true;
                this.el.buyBtn.disabled = true;
                this.el.sellBtn.disabled = true;
                this.el.flattenBtn.disabled = true;
                this.el.buyStopBtn.disabled = true;
                this.el.sellStopBtn.disabled = true;
                this.el.connectBtn.disabled = !this.currentAsset;
            }
            // Auto-reconnect after a short delay so alerts resume flowing.
            if (this._wsReconnectTimer) clearTimeout(this._wsReconnectTimer);
            this._wsReconnectTimer = setTimeout(() => this._setupWs(), 3000);
        };
    }

    async _handlePrime(p) {
        // Drop stale primes from a prior subscribe. Asset switches that race
        // against a slow prime build (cold splice cache) would otherwise
        // load the OLD asset's bars into a chart configured for the NEW
        // asset — bar prices and contract symbol from the old asset, but
        // tick size / point value / decimals from the new one.
        if (!p || !p.asset || p.asset !== this._wantsLiveAsset) return;
        let asset;
        try { asset = AssetCfg.getAsset(p.asset); }
        catch (_) { return; }
        if (!asset) return;
        this.chart.setAsset(asset);
        this.simulator.setAsset(asset);
        this.simulator.reset();
        // Clear ranks BEFORE pushing new bars into the chart. Otherwise the
        // window between loadPrime and _ensureRanks completing leaves the
        // rankEngine with the PRIOR asset's bucket distributions while ticks
        // and hover events compute ranks against new-asset bars — silently
        // wrong percentages until the /ranks fetch returns.
        this.rankEngine.clear();
        const tf = parseInt(this.el.timeframeSelect.value, 10);
        this.liveEngine.setTradeSimulator(this.simulator);
        this.liveEngine.loadPrime({
            bars: p.bars,
            rolls: p.rolls_in_range,
            sessions: p.sessions,
            timeframeMin: tf,
        });
        this.liveEngine.connected = true;
        this._liveEntrySession = p.entry_session;
        this.el.loadedSessions.textContent = this.liveEngine.getLoadedSessionCount();
        this.el.disconnectBtn.disabled = false;
        this.el.connectBtn.disabled = false;
        this.el.buyBtn.disabled = false;
        this.el.sellBtn.disabled = false;
        this.el.flattenBtn.disabled = false;
        this.el.buyStopBtn.disabled = false;
        this.el.sellStopBtn.disabled = false;
        this._status(`Live: primed ${asset.symbol} (${p.entry_contract || 'no contract'}) — ${p.bars.length} historical bars. Ranks loading… Awaiting live ticks.`);
        if (p.entry_session) {
            const lookbackDays = this._readLookbackDays();
            const rankData = await this._ensureRanks(asset.symbol, tf, p.entry_session, lookbackDays);
            if (rankData) {
                this._status(`Live: ${asset.symbol} (${p.entry_contract}) — ranks ready (n=${rankData.n_sessions_with_data} sessions).`);
            } else {
                this._status(`Live: ${asset.symbol} (${p.entry_contract}) — ranks unavailable.`);
            }
        }
    }

    _connectLive() {
        if (!this.currentAsset) return;
        this._ensureAudioCtx();  // warm audio on user gesture so beeps work later
        const sym = this.currentAsset.symbol;
        this._wantsLiveAsset = sym;
        this._status(`Subscribing to live feed for ${sym}...`);
        this.el.connectBtn.disabled = true;
        if (!this._liveWs || this._liveWs.readyState !== WebSocket.OPEN) {
            // WS not yet open or still reconnecting — _setupWs's onopen handler
            // will pick up _wantsLiveAsset and subscribe automatically.
            return;
        }
        this._liveWs.send(JSON.stringify({ op: 'subscribe', asset: sym }));
    }

    _disconnectLive(announce = true) {
        // Send unsubscribe but DO NOT close the WS — alerts still need it.
        this._wantsLiveAsset = null;
        if (this._liveWs && this._liveWs.readyState === WebSocket.OPEN) {
            try { this._liveWs.send(JSON.stringify({ op: 'unsubscribe' })); } catch (_) {}
        }
        this.liveEngine.connected = false;
        if (announce && this.mode === 'live') {
            this.el.connectBtn.disabled = !this.currentAsset;
            this.el.disconnectBtn.disabled = true;
            this.el.buyBtn.disabled = true;
            this.el.sellBtn.disabled = true;
            this.el.flattenBtn.disabled = true;
            this.el.buyStopBtn.disabled = true;
            this.el.sellStopBtn.disabled = true;
            this._status('Live disconnected (alerts still active).');
        }
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const app = new App();
    await app.init();
});
