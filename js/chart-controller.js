// Chart Controller - Manages Lightweight Charts instance
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

        this.onHoverCallback = null;

        // Subscribe to crosshair movement for hover OHLC display
        this.chart.subscribeCrosshairMove((param) => {
            if (param.time && param.seriesData.size > 0) {
                const data = param.seriesData.get(this.candlestickSeries);
                if (data && this.onHoverCallback) {
                    this.onHoverCallback(data);
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
        const data = bars.map(bar => ({
            time: bar.time || bar.timestamp / 1000,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close
        }));

        this.candlestickSeries.setData(data);
    }

    updateBar(bar) {
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
}

export default ChartController;