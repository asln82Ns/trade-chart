// ChartController — Lightweight Charts wrapper with:
//   • candlestick series (price space defined by entry contract)
//   • volume histogram pane
//   • ET-formatted axis tick marks
//   • 10-tick gridlines via priceFormat.minMove
//   • roll markers (setMarkers) at contract changeover boundaries
//
// All times are unix-seconds (UTC). Display formatting is ET only.

import { formatEtTickMark, formatEt } from './time-utils.js';

class ChartController {
    constructor(container) {
        this.container = container;
        // Anchor the absolute-positioned session-line overlay.
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        this.sessionLineOverlay = document.createElement('div');
        this.sessionLineOverlay.style.cssText = [
            'position:absolute', 'top:0', 'left:0',
            'width:100%', 'height:100%',
            'pointer-events:none', 'overflow:hidden', 'z-index:2',
        ].join(';');
        container.appendChild(this.sessionLineOverlay);
        this.sessionOpens = [];
        this.chart = LightweightCharts.createChart(container, {
            width: container.clientWidth,
            height: container.clientHeight,
            layout: {
                background: { color: '#1a1a1a' },
                textColor: '#d1d4dc',
            },
            grid: {
                vertLines: { color: '#2a2a2a' },
                horzLines: { color: '#2a2a2a' },
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: '#2a2a2a', scaleMargins: { top: 0.05, bottom: 0.25 } },
            timeScale: {
                borderColor: '#2a2a2a',
                timeVisible: true,
                secondsVisible: true,
                tickMarkFormatter: (time) => formatEtTickMark(time),
            },
            localization: {
                timeFormatter: (time) => formatEt(time, { label: true }),
            },
        });

        // Ghost candle series — added BEFORE the real series so it draws
        // beneath, leaving the user's real bars solid on top. Translucent
        // colors make where the two overlap render as a faint tint rather
        // than washing the real bar out.
        this.ghostSeries = this.chart.addCandlestickSeries({
            upColor: 'rgba(80, 145, 220, 0.35)',     // blue ghost
            downColor: 'rgba(180, 180, 180, 0.35)',  // gray ghost
            borderVisible: false,
            wickUpColor: 'rgba(80, 145, 220, 0.35)',
            wickDownColor: 'rgba(180, 180, 180, 0.35)',
            priceLineVisible: false,
            lastValueVisible: false,
        });

        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderVisible: false,
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
        });

        this.volumeSeries = this.chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: 'vol',
            color: '#5c5c5c',
        });
        this.chart.priceScale('vol').applyOptions({
            scaleMargins: { top: 0.78, bottom: 0 },
        });

        this.barMetadata = new Map(); // unix-sec -> {volume, contract, sessionDate}
        this.ghostMetadata = new Map(); // unix-sec -> {n, pctBlue, pctGray, color, volume, forward}
        this.stopPriceLines = new Map(); // stop.id -> IPriceLine handle
        this._hoverActive = false;       // true while cursor is on a real bar
        this.onHoverEndCallback = null;  // fired on hover true→false transition
        this.lastCandleData = [];       // snapshot of last setData payload — lets
                                        // refreshGhostOverlay recompute without
                                        // dipping back into the engine
        this.markers = [];             // current marker list
        this.onHoverCallback = null;
        this.assetCfg = null;
        this.ghostEngine = null;       // optional GhostEngine; if set, ghost overlay
                                        // recomputes automatically on every setData
        this.ghostRealtimeMode = false; // when true, within-bar updates also
                                        // trigger ghost recompute (forward
                                        // ghosts depend on forming.close)

        this.chart.subscribeCrosshairMove((param) => {
            const candle = param && param.time ? param.seriesData.get(this.candleSeries) : null;
            if (!candle) {
                // Cursor left the chart or hovered an area with no bar — emit
                // a one-shot hover-end so the consumer can restore live values.
                if (this._hoverActive) {
                    this._hoverActive = false;
                    if (this.onHoverEndCallback) this.onHoverEndCallback();
                }
                return;
            }
            this._hoverActive = true;
            if (!this.onHoverCallback) return;
            const meta = this.barMetadata.get(param.time) || {};
            const ghost = this.ghostMetadata.get(param.time) || null;
            this.onHoverCallback({
                time: param.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                ...meta,
                ghost,
            });
        });

        window.addEventListener('resize', () => {
            this.chart.applyOptions({
                width: container.clientWidth,
                height: container.clientHeight,
            });
            this._redrawSessionLines();
        });

        this.chart.timeScale().applyOptions({
            rightOffset: 10,
            barSpacing: 6,
        });

        this.chart.timeScale().subscribeVisibleTimeRangeChange(() => this._redrawSessionLines());
        this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this._redrawSessionLines());
    }

    /** Tell the chart which asset is loaded so price formatting reflects tick size. */
    setAsset(asset) {
        this.assetCfg = asset;
        // Decouple axis-tick spacing from displayed precision:
        //   minMove = 10 * tick_size  → axis ticks land every 10 ticks
        //   formatter prints full tick precision  → crosshair shows real price
        // type:'custom' is what skips minMove-based quantization of the value.
        const minMove = +(asset.tick_size * 10).toFixed(asset.price_decimals + 1);
        const decimals = asset.price_decimals;
        this.candleSeries.applyOptions({
            priceFormat: {
                type: 'custom',
                minMove: minMove,
                formatter: (price) => price.toFixed(decimals),
            },
        });
    }

    /** Replace all bars + markers (used on initial load and timeframe switch). */
    setData(bars, markers = []) {
        this.barMetadata.clear();
        const candleData = new Array(bars.length);
        const volumeData = new Array(bars.length);
        for (let i = 0; i < bars.length; i++) {
            const b = bars[i];
            candleData[i] = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
            volumeData[i] = {
                time: b.time,
                value: b.volume || 0,
                color: b.close >= b.open ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)',
            };
            this.barMetadata.set(b.time, {
                volume: b.volume || 0,
                contract: b.contract || null,
                sessionDate: b.sessionDate || null,
            });
        }
        this.candleSeries.setData(candleData);
        this.volumeSeries.setData(volumeData);
        this.setMarkers(markers);
        this.lastCandleData = candleData;
        this._recomputeGhostOverlay();
    }

    /** Set the GhostEngine the chart should consult on every setData. Pass
     *  null to detach (clears any in-flight ghost rendering). */
    setGhostEngine(engine) {
        this.ghostEngine = engine || null;
        if (!this.ghostEngine) {
            this._clearGhostOverlay();
        } else {
            this._recomputeGhostOverlay();
        }
    }

    /** Enable within-bar recompute. Required for realtime-anchor mode
     *  where forward ghosts chain from the forming bar's CURRENT close
     *  (which moves continuously). Session-anchor mode leaves this off
     *  so we don't burn cycles on every 1s tick. */
    setGhostRealtimeMode(on) {
        this.ghostRealtimeMode = !!on;
    }

    /** Force a ghost-overlay redraw using the bars already on the chart.
     *  Call after the engine receives new data but the chart's bar set is
     *  unchanged. */
    refreshGhostOverlay() {
        this._recomputeGhostOverlay();
    }

    _recomputeGhostOverlay() {
        if (!this.ghostEngine || !this.ghostEngine.hasData()) {
            this._clearGhostOverlay();
            return;
        }
        const ghostBars = this.ghostEngine.computeOverlay(this.lastCandleData);
        const ghostSeriesData = new Array(ghostBars.length);
        this.ghostMetadata.clear();
        for (let i = 0; i < ghostBars.length; i++) {
            const g = ghostBars[i];
            ghostSeriesData[i] = {
                time: g.time, open: g.open, high: g.high, low: g.low, close: g.close,
            };
            this.ghostMetadata.set(g.time, {
                n: g.n,
                pctBlue: g.pctBlue,
                pctGray: g.pctGray,
                color: g.color,
                volume: g.volume,
                forward: !!g.forward,
            });
        }
        this.ghostSeries.setData(ghostSeriesData);
    }

    _clearGhostOverlay() {
        this.ghostMetadata.clear();
        this.ghostSeries.setData([]);
    }

    /** Update or append the live (forming) bar. */
    updateBar(bar) {
        this.candleSeries.update({
            time: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
        });
        this.volumeSeries.update({
            time: bar.time,
            value: bar.volume || 0,
            color: bar.close >= bar.open ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)',
        });
        this.barMetadata.set(bar.time, {
            volume: bar.volume || 0,
            contract: bar.contract || null,
            sessionDate: bar.sessionDate || null,
        });

        // Keep lastCandleData in sync with the chart so ghost overlay can
        // recompute against the bar set the user actually sees. New-bar
        // transitions always trigger a recompute. Within-bar updates only
        // recompute when realtime-anchor mode is on, because forward
        // ghosts in that mode chain from the forming bar's current close.
        const last = this.lastCandleData[this.lastCandleData.length - 1];
        if (!last || last.time < bar.time) {
            this.lastCandleData.push({
                time: bar.time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
            });
            this._recomputeGhostOverlay();
        } else if (last.time === bar.time) {
            // Same bar — refresh OHLC but never overwrite open (ghost.open
            // for the forming bar depends on its INITIAL open, recorded
            // when the bar first appeared).
            last.high = bar.high;
            last.low = bar.low;
            last.close = bar.close;
            if (this.ghostRealtimeMode) {
                this._recomputeGhostOverlay();
            }
        }
    }

    /** rolls: [{time, fromContract, toContract, spread, incomplete}] */
    setMarkers(rolls) {
        this.markers = rolls.map(r => ({
            time: r.time,
            position: 'aboveBar',
            color: r.incomplete ? '#ff9800' : '#42a5f5',
            shape: 'arrowDown',
            text: `${r.fromContract}→${r.toContract}${r.incomplete ? ' (partial)' : ''}`,
        }));
        this.candleSeries.setMarkers(this.markers);
    }

    /** Sync horizontal price lines to the given pending stops list.
     *  stops: [{id, type, quantity, stopPrice}] — diff against last render
     *  to add new lines and remove cleared/triggered ones. */
    setStopOrderLines(stops) {
        const seen = new Set();
        for (const s of stops) {
            seen.add(s.id);
            const existing = this.stopPriceLines.get(s.id);
            const decimals = this.assetCfg?.price_decimals ?? 2;
            const opts = {
                price: s.stopPrice,
                color: s.type === 'buy' ? '#4caf50' : '#f44336',
                lineWidth: 1,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: `${s.type === 'buy' ? 'BUY' : 'SELL'} STOP ${s.quantity} @ ${s.stopPrice.toFixed(decimals)}`,
            };
            if (existing) existing.applyOptions(opts);
            else this.stopPriceLines.set(s.id, this.candleSeries.createPriceLine(opts));
        }
        for (const [id, line] of this.stopPriceLines) {
            if (!seen.has(id)) {
                this.candleSeries.removePriceLine(line);
                this.stopPriceLines.delete(id);
            }
        }
    }

    setVisibleRange(fromUnix, toUnix) {
        this.chart.timeScale().setVisibleRange({ from: fromUnix, to: toUnix });
    }

    fitContent() { this.chart.timeScale().fitContent(); }

    setHoverCallback(cb) { this.onHoverCallback = cb; }
    setHoverEndCallback(cb) { this.onHoverEndCallback = cb; }
    isHovering() { return this._hoverActive; }

    clear() {
        this.barMetadata.clear();
        this.markers = [];
        for (const line of this.stopPriceLines.values()) this.candleSeries.removePriceLine(line);
        this.stopPriceLines.clear();
        this.candleSeries.setData([]);
        this.volumeSeries.setData([]);
        this.candleSeries.setMarkers([]);
        this.sessionOpens = [];
        this._redrawSessionLines();
        this._clearGhostOverlay();
        // Hover state belongs to the prior dataset — reset so a stale hover
        // flag doesn't suppress live updates after a mode switch / reload.
        this._hoverActive = false;
    }

    /** Set the unix-second timestamps where 18:00 ET session opens occur. */
    setSessionOpens(times) {
        this.sessionOpens = (times || []).slice().sort((a, b) => a - b);
        this._redrawSessionLines();
    }

    _redrawSessionLines() {
        if (!this.sessionLineOverlay) return;
        const ts = this.chart.timeScale();
        const range = ts.getVisibleRange ? ts.getVisibleRange() : null;
        this.sessionLineOverlay.replaceChildren();
        if (!range || !this.sessionOpens.length) return;
        for (const t of this.sessionOpens) {
            if (t < range.from || t > range.to) continue;
            const x = ts.timeToCoordinate(t);
            if (x == null) continue;
            const line = document.createElement('div');
            line.style.cssText = [
                'position:absolute',
                'top:0', `left:${x}px`,
                'width:1px', 'height:100%',
                'background:rgba(255,221,0,0.18)',
                'pointer-events:none',
            ].join(';');
            this.sessionLineOverlay.appendChild(line);
        }
    }
}

export default ChartController;
