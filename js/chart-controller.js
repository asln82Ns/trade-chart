// Chart Controller - Manages Lightweight Charts instance with metadata access
class ChartController {
    constructor(container) {
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
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
            rightPriceScale: {
                borderColor: '#2a2a2a',
            },
            timeScale: {
                borderColor: '#2a2a2a',
                timeVisible: true,
                secondsVisible: true,
                tickMarkFormatter: (time) => {
                    const date = new Date(time * 1000);
                    return this.formatUTCTime(date);
                },
            },
        });

        this.candlestickSeries = this.chart.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderVisible: false,
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
        });

        // Store bar metadata for hover access
        this.barMetadata = new Map(); // key: timestamp, value: {totalVolume, totalTrades, bidTrades, askTrades}
        
        this.onHoverCallback = null;

        // Subscribe to crosshair movement for hover OHLC + metadata display
        this.chart.subscribeCrosshairMove((param) => {
            if (param.time && param.seriesData.size > 0) {
                const data = param.seriesData.get(this.candlestickSeries);
                if (data && this.onHoverCallback) {
                    // Get metadata for this bar
                    const timestamp = param.time * 1000; // Convert back to ms
                    const metadata = this.barMetadata.get(timestamp) || {
                        totalVolume: 0,
                        totalTrades: 0,
                        bidTrades: 0,
                        askTrades: 0
                    };
                    
                    // Pass both OHLC and metadata
                    this.onHoverCallback({
                        ...data,
                        timestamp: timestamp,
                        ...metadata
                    });
                }
            }
        });

        window.addEventListener('resize', () => {
            this.chart.applyOptions({
                width: container.clientWidth,
                height: container.clientHeight,
            });
        });

        this.chart.timeScale().applyOptions({
            rightOffset: 10,
            barSpacing: 6,
            fixLeftEdge: false,
            fixRightEdge: false,
        });
    }

    formatUTCTime(date) {
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${minutes}`;
    }

    setData(bars) {
        // Clear existing metadata
        this.barMetadata.clear();
        
        const data = bars.map(bar => {
            const timestamp = bar.time || bar.timestamp / 1000;
            
            // Store metadata
            this.barMetadata.set(timestamp * 1000, {
                totalVolume: bar.totalVolume || 0,
                totalTrades: bar.totalTrades || 0,
                bidTrades: bar.bidTrades || 0,
                askTrades: bar.askTrades || 0
            });
            
            return {
                time: timestamp,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close
            };
        });

        this.candlestickSeries.setData(data);
    }

    updateBar(bar) {
        const timestamp = bar.time * 1000;
        
        // Update metadata
        this.barMetadata.set(timestamp, {
            totalVolume: bar.totalVolume || 0,
            totalTrades: bar.totalTrades || 0,
            bidTrades: bar.bidTrades || 0,
            askTrades: bar.askTrades || 0
        });
        
        this.candlestickSeries.update({
            time: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close
        });
    }

    fitContent() {
        this.chart.timeScale().fitContent();
    }

    scrollToRealtime() {
        this.chart.timeScale().scrollToRealTime();
    }

    setVisibleRange(from, to) {
        this.chart.timeScale().setVisibleRange({
            from: from / 1000,
            to: to / 1000
        });
    }

    setHoverCallback(callback) {
        this.onHoverCallback = callback;
    }

    clearMetadata() {
        this.barMetadata.clear();
    }
}

export default ChartController;