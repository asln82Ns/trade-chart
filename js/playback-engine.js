// Playback Engine - Handles tick-by-tick replay
class PlaybackEngine {
    constructor(chartController) {
        this.chartController = chartController;
        this.allBars = [];
        this.contextBars = [];
        this.replayBars = [];
        this.currentBarIndex = 0;
        this.currentTradeIndex = 0;
        this.isPlaying = false;
        this.ticksPerSecond = 25;
        this.lastFrameTime = 0;
        this.tickAccumulator = 0;
        this.animationFrameId = null;
        this.currentBar = null;
        this.onTickCallback = null;
        this.onBarCompleteCallback = null;
    }

    loadBars(bars) {
        this.allBars = bars;
        
        const contextCount = Math.min(400, bars.length);
        this.contextBars = bars.slice(0, contextCount);
        this.replayBars = bars.slice(contextCount);
        
        this.currentBarIndex = 0;
        this.currentTradeIndex = 0;
        this.currentBar = null;
        
        const contextData = this.contextBars.map(bar => ({
            time: bar.timestamp / 1000,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close
        }));
        
        this.chartController.setData(contextData);
        
        if (this.contextBars.length > 0) {
            const startIdx = Math.max(0, this.contextBars.length - 200);
            this.chartController.setVisibleRange(
                this.contextBars[startIdx].timestamp,
                this.contextBars[this.contextBars.length - 1].timestamp + 300000
            );
        }
    }

    setSpeed(ticksPerSecond) {
        this.ticksPerSecond = Math.max(5, Math.min(500, ticksPerSecond));
    }

    play() {
        if (this.isPlaying) return;
        if (this.replayBars.length === 0) {
            alert('No bars to replay. Load data past your jump time.');
            return;
        }
        
        // Only reset if we've completed playback or haven't started
        // This fixes the "Cannot update oldest data" error when resuming from pause
        if (this.currentBarIndex >= this.replayBars.length) {
            this.currentBarIndex = 0;
            this.currentTradeIndex = 0;
            this.currentBar = null;
        }
        // If paused mid-playback, continue from current position
        
        this.isPlaying = true;
        this.lastFrameTime = performance.now();
        this.tickAccumulator = 0;
        this.animate();
    }

    pause() {
        this.isPlaying = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    reset() {
        this.pause();
        this.currentBarIndex = 0;
        this.currentTradeIndex = 0;
        this.currentBar = null;
        
        const contextData = this.contextBars.map(bar => ({
            time: bar.timestamp / 1000,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close
        }));
        
        this.chartController.setData(contextData);
    }

    animate() {
        if (!this.isPlaying) return;

        const now = performance.now();
        const deltaTime = (now - this.lastFrameTime) / 1000;
        this.lastFrameTime = now;

        this.tickAccumulator += deltaTime * this.ticksPerSecond;
        const ticksToProcess = Math.floor(this.tickAccumulator);
        this.tickAccumulator -= ticksToProcess;

        for (let i = 0; i < ticksToProcess; i++) {
            if (!this.processTick()) {
                this.pause();
                return;
            }
        }

        this.animationFrameId = requestAnimationFrame(() => this.animate());
    }

    processTick() {
        if (this.currentBarIndex >= this.replayBars.length) {
            return false;
        }

        const bar = this.replayBars[this.currentBarIndex];
        
        if (this.currentBar === null || this.currentBar.timestamp !== bar.timestamp) {
            this.currentBar = {
                timestamp: bar.timestamp,
                open: bar.open,
                high: bar.open,
                low: bar.open,
                close: bar.open
            };
        }

        if (this.currentTradeIndex < bar.trades.length) {
            const trade = bar.trades[this.currentTradeIndex];
            
            this.currentBar.high = Math.max(this.currentBar.high, trade.price);
            this.currentBar.low = Math.min(this.currentBar.low, trade.price);
            this.currentBar.close = trade.price;
            
            this.chartController.updateBar({
                time: this.currentBar.timestamp / 1000,
                open: this.currentBar.open,
                high: this.currentBar.high,
                low: this.currentBar.low,
                close: this.currentBar.close
            });
            
            if (this.onTickCallback) {
                this.onTickCallback({
                    bar: this.currentBar,
                    trade: trade,
                    barIndex: this.currentBarIndex,
                    tradeIndex: this.currentTradeIndex,
                    totalTrades: bar.trades.length
                });
            }
            
            this.currentTradeIndex++;
        }

        if (this.currentTradeIndex >= bar.trades.length) {
            if (this.onBarCompleteCallback) {
                this.onBarCompleteCallback(this.currentBar);
            }
            
            this.currentBarIndex++;
            this.currentTradeIndex = 0;
            this.currentBar = null;
        }

        return true;
    }

    onTick(callback) {
        this.onTickCallback = callback;
    }

    onBarComplete(callback) {
        this.onBarCompleteCallback = callback;
    }

    getCurrentState() {
        return {
            barIndex: this.currentBarIndex,
            tradeIndex: this.currentTradeIndex,
            currentBar: this.currentBar,
            totalReplayBars: this.replayBars.length,
            isPlaying: this.isPlaying
        };
    }
}

export default PlaybackEngine;