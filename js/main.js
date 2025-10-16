// Main application entry point
import DBManager from './db-manager.js';
import CSVProcessor from './csv-processor.js';
import ChartController from './chart-controller.js';
import PlaybackEngine from './playback-engine.js';
import TradeSimulator from './trade-simulator.js';
import DirectionTracker from './direction-tracker.js';

class TradeChartApp {
    constructor() {
        this.dbManager = new DBManager();
        this.csvProcessor = null;
        this.chartController = null;
        this.tradeSimulator = null;
        this.directionTracker = null;
        this.playbackEngine = null;
        
        this.initializeUI();
    }

    async init() {
        try {
            await this.dbManager.init();
            this.updateStatus('Ready');
            
            const isProcessed = await this.dbManager.isDataProcessed();
            if (isProcessed) {
                const totalBars = await this.dbManager.getMetadata('totalBars');
                this.updateStatus(`Data loaded (${totalBars} bars)`);
                this.enableJumpControls();
            }
        } catch (error) {
            console.error('Initialization error:', error);
            this.updateStatus('Error initializing database');
        }
    }

    initializeUI() {
        this.elements = {
            csvFile: document.getElementById('csvFile'),
            processBtn: document.getElementById('processBtn'),
            processProgress: document.getElementById('processProgress'),
            progressFill: document.getElementById('progressFill'),
            progressText: document.getElementById('progressText'),
            jumpTime: document.getElementById('jumpTime'),
            jumpBtn: document.getElementById('jumpBtn'),
            playBtn: document.getElementById('playBtn'),
            pauseBtn: document.getElementById('pauseBtn'),
            resetBtn: document.getElementById('resetBtn'),
            speedControl: document.getElementById('speedControl'),
            speedValue: document.getElementById('speedValue'),
            speedPresetBtns: document.querySelectorAll('.speed-preset-btn'),
            status: document.getElementById('status'),
            currentTime: document.getElementById('currentTime'),
            currentOpen: document.getElementById('currentOpen'),
            currentHigh: document.getElementById('currentHigh'),
            currentLow: document.getElementById('currentLow'),
            currentClose: document.getElementById('currentClose'),
            barProgress: document.getElementById('barProgress'),
            loadedBars: document.getElementById('loadedBars'),
            chartContainer: document.getElementById('chartContainer'),
            // Trade controls
            buyBtn: document.getElementById('buyBtn'),
            sellBtn: document.getElementById('sellBtn'),
            quantityInput: document.getElementById('quantityInput'),
            tradeLogBtn: document.getElementById('tradeLogBtn'),
            positionDisplay: document.getElementById('positionDisplay'),
            avgEntryDisplay: document.getElementById('avgEntryDisplay'),
            realizedPnL: document.getElementById('realizedPnL'),
            unrealizedPnL: document.getElementById('unrealizedPnL'),
            totalPnL: document.getElementById('totalPnL'),
            // Modal
            tradeLogModal: document.getElementById('tradeLogModal'),
            tradeLogContent: document.getElementById('tradeLogContent'),
            closeModal: document.querySelector('.close-modal')
        };

        this.chartController = new ChartController(this.elements.chartContainer);
        this.tradeSimulator = new TradeSimulator();
        this.directionTracker = new DirectionTracker();
        this.playbackEngine = new PlaybackEngine(this.chartController, this.tradeSimulator, this.directionTracker);

        this.playbackEngine.onTick((data) => {
            this.updatePlaybackInfo(data);

            // Update direction points every tick
            const directionPoints = this.directionTracker.getDirectionPoints();
            this.chartController.updateDirectionPoints(directionPoints);
        });

        // Trade simulator updates
        this.tradeSimulator.onUpdate((state) => {
            this.updateTradeInfo(state);
        });

        // Setup hover callback to display OHLC on crosshair
        this.chartController.setHoverCallback((data) => {
            // Only update on hover when not playing (during playback, onTick updates these)
            if (!this.playbackEngine.getCurrentState().isPlaying) {
                this.elements.currentOpen.textContent = data.open.toFixed(2);
                this.elements.currentHigh.textContent = data.high.toFixed(2);
                this.elements.currentLow.textContent = data.low.toFixed(2);
                this.elements.currentClose.textContent = data.close.toFixed(2);
            }
        });

        this.elements.csvFile.addEventListener('change', (e) => {
            this.elements.processBtn.disabled = !e.target.files[0];
        });

        this.elements.processBtn.addEventListener('click', () => this.processCSV());
        this.elements.jumpBtn.addEventListener('click', () => this.jumpToTime());
        this.elements.playBtn.addEventListener('click', () => this.play());
        this.elements.pauseBtn.addEventListener('click', () => this.pause());
        this.elements.resetBtn.addEventListener('click', () => this.reset());
        
        this.elements.speedControl.addEventListener('input', (e) => {
            const speed = parseInt(e.target.value);
            this.elements.speedValue.textContent = speed;
            this.playbackEngine.setSpeed(speed);
        });

        // Speed preset buttons
        this.elements.speedPresetBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const speed = parseInt(btn.dataset.speed);
                this.elements.speedControl.value = speed;
                this.elements.speedValue.textContent = speed;
                this.playbackEngine.setSpeed(speed);
            });
        });

        // Trade controls
        this.elements.buyBtn.addEventListener('click', () => this.placeBuyOrder());
        this.elements.sellBtn.addEventListener('click', () => this.placeSellOrder());
        this.elements.tradeLogBtn.addEventListener('click', () => this.showTradeLog());

        // Modal controls
        this.elements.closeModal.addEventListener('click', () => this.closeTradeLog());
        window.addEventListener('click', (e) => {
            if (e.target === this.elements.tradeLogModal) {
                this.closeTradeLog();
            }
        });
    }

    async processCSV() {
        const file = this.elements.csvFile.files[0];
        if (!file) return;

        try {
            this.elements.processBtn.disabled = true;
            this.elements.csvFile.disabled = true;
            this.elements.processProgress.style.display = 'block';
            
            this.updateStatus('Processing CSV...');

            await this.dbManager.clearAll();

            this.csvProcessor = new CSVProcessor(this.dbManager);
            this.csvProcessor.setProgressCallback((rowsProcessed) => {
                const rowsText = rowsProcessed.toLocaleString();
                this.elements.progressFill.style.width = '100%';
                this.elements.progressText.textContent = `${rowsText} rows`;
            });

            const result = await this.csvProcessor.processFile(file);

            this.updateStatus(`Complete: ${result.totalBars} bars from ${result.totalRows.toLocaleString()} rows`);
            this.elements.processProgress.style.display = 'none';
            this.elements.csvFile.disabled = false;
            
            this.enableJumpControls();

        } catch (error) {
            console.error('Processing error:', error);
            
            let errorMsg = 'Error processing CSV';
            if (error.message.includes('No valid bars')) {
                errorMsg = 'No valid data found. Check CSV format (datetime, price columns required)';
            }
            
            this.updateStatus(errorMsg);
            alert(errorMsg + '\n\nCheck browser console for details.');
            
            this.elements.processBtn.disabled = false;
            this.elements.csvFile.disabled = false;
            this.elements.processProgress.style.display = 'none';
        }
    }

    async jumpToTime() {
        const jumpTimeValue = this.elements.jumpTime.value;
        if (!jumpTimeValue) {
            alert('Please enter a time to jump to');
            return;
        }

        try {
            this.updateStatus('Loading bars...');
            
            const parts = jumpTimeValue.split('T');
            const dateParts = parts[0].split('-');
            const timeParts = parts[1].split(':');
            
            const targetDate = new Date(Date.UTC(
                parseInt(dateParts[0]),
                parseInt(dateParts[1]) - 1,
                parseInt(dateParts[2]),
                parseInt(timeParts[0]),
                parseInt(timeParts[1]),
                parseInt(timeParts[2] || 0)
            ));
            
            const targetTimestamp = targetDate.getTime();

            const barDuration = 5 * 60 * 1000;
            const startTime = targetTimestamp - (400 * barDuration);
            
            // Load ALL remaining bars to end of dataset (instead of just 200)
            const lastTimestamp = await this.dbManager.getMetadata('lastTimestamp');
            const endTime = lastTimestamp;

            const bars = await this.dbManager.getBarsInRange(startTime, endTime);

            if (bars.length === 0) {
                alert('No data found for this time range');
                this.updateStatus('No data found');
                return;
            }

            this.playbackEngine.loadBars(bars);

            // Extract all trades from same UTC day for direction tracker
            const loadDate = new Date(targetTimestamp).toISOString().split('T')[0];
            const sameDayTrades = [];
            
            for (const bar of bars) {
                const barDate = new Date(bar.timestamp).toISOString().split('T')[0];
                if (barDate === loadDate) {
                    for (const trade of bar.trades) {
                        sameDayTrades.push(trade);
                    }
                }
            }
            
            // Initialize direction tracker with historical data
            this.directionTracker.initializeFromHistory(sameDayTrades);
            
            // Update chart with initial direction points
            const directionPoints = this.directionTracker.getDirectionPoints();
            this.chartController.updateDirectionPoints(directionPoints);
            
            const contextCount = Math.min(400, bars.length);
            const replayCount = Math.max(0, bars.length - 400);
            this.elements.loadedBars.textContent = `${bars.length} (${contextCount} context + ${replayCount} replay)`;
            this.updateStatus(`Loaded ${bars.length} bars`);
            
            // Reset trade simulator on new load
            this.tradeSimulator.reset();
            
            this.enablePlaybackControls();

        } catch (error) {
            console.error('Jump error:', error);
            this.updateStatus('Error loading data');
        }
    }

    play() {
        this.playbackEngine.play();
        this.elements.playBtn.disabled = true;
        this.elements.pauseBtn.disabled = false;
        this.elements.buyBtn.disabled = false;
        this.elements.sellBtn.disabled = false;
        this.updateStatus('Playing');
    }

    pause() {
        this.playbackEngine.pause();
        this.elements.playBtn.disabled = false;
        this.elements.pauseBtn.disabled = true;
        this.elements.buyBtn.disabled = true;
        this.elements.sellBtn.disabled = true;
        this.updateStatus('Paused');
    }

    reset() {
        this.playbackEngine.reset();
        this.tradeSimulator.reset();
        this.directionTracker.reset();
        this.chartController.clearDirectionPoints();
        this.elements.playBtn.disabled = false;
        this.elements.pauseBtn.disabled = true;
        this.elements.buyBtn.disabled = true;
        this.elements.sellBtn.disabled = true;
        this.updateStatus('Reset');
        this.elements.currentTime.textContent = '--';
        this.elements.currentOpen.textContent = '--';
        this.elements.currentHigh.textContent = '--';
        this.elements.currentLow.textContent = '--';
        this.elements.currentClose.textContent = '--';
        this.elements.barProgress.textContent = '--';
    }

    placeBuyOrder() {
        if (!this.playbackEngine.getCurrentState().isPlaying) {
            return;
        }

        const quantity = parseInt(this.elements.quantityInput.value);
        if (isNaN(quantity) || quantity <= 0) {
            alert('Please enter a valid quantity (positive integer)');
            return;
        }

        const trade = this.playbackEngine.getCurrentTrade();
        if (!trade) {
            alert('No current trade available');
            return;
        }

        try {
            this.tradeSimulator.placeOrder('buy', quantity, trade.time);
            this.updateStatus(`BUY order placed: ${quantity} contracts`);
        } catch (error) {
            alert(error.message);
        }
    }

    placeSellOrder() {
        if (!this.playbackEngine.getCurrentState().isPlaying) {
            return;
        }

        const quantity = parseInt(this.elements.quantityInput.value);
        if (isNaN(quantity) || quantity <= 0) {
            alert('Please enter a valid quantity (positive integer)');
            return;
        }

        const trade = this.playbackEngine.getCurrentTrade();
        if (!trade) {
            alert('No current trade available');
            return;
        }

        try {
            this.tradeSimulator.placeOrder('sell', quantity, trade.time);
            this.updateStatus(`SELL order placed: ${quantity} contracts`);
        } catch (error) {
            alert(error.message);
        }
    }

    updatePlaybackInfo(data) {
        const date = new Date(data.bar.timestamp);
        this.elements.currentTime.textContent = this.formatUTCDateTime(date);
        
        // Update OHLC prices
        this.elements.currentOpen.textContent = data.bar.open.toFixed(2);
        this.elements.currentHigh.textContent = data.bar.high.toFixed(2);
        this.elements.currentLow.textContent = data.bar.low.toFixed(2);
        this.elements.currentClose.textContent = data.bar.close.toFixed(2);
        
        const progress = ((data.tradeIndex + 1) / data.totalTrades * 100).toFixed(1);
        this.elements.barProgress.textContent = `${data.tradeIndex + 1}/${data.totalTrades} (${progress}%)`;
    }

    updateTradeInfo(state) {
        // Position
        let positionText = 'FLAT';
        if (state.position > 0) {
            positionText = `LONG ${state.position}`;
        } else if (state.position < 0) {
            positionText = `SHORT ${Math.abs(state.position)}`;
        }
        this.elements.positionDisplay.textContent = positionText;

        // Average entry price
        if (state.avgEntryPrice > 0) {
            this.elements.avgEntryDisplay.textContent = state.avgEntryPrice.toFixed(2);
        } else {
            this.elements.avgEntryDisplay.textContent = '--';
        }

        // P&L
        this.elements.realizedPnL.textContent = this.formatPnL(state.realizedPnL);
        this.elements.unrealizedPnL.textContent = this.formatPnL(state.unrealizedPnL);
        this.elements.totalPnL.textContent = this.formatPnL(state.totalPnL);

        // Color code total P&L
        if (state.totalPnL > 0) {
            this.elements.totalPnL.style.color = '#4caf50';
        } else if (state.totalPnL < 0) {
            this.elements.totalPnL.style.color = '#f44336';
        } else {
            this.elements.totalPnL.style.color = '#e0e0e0';
        }
    }

    formatPnL(value) {
        const sign = value >= 0 ? '+' : '';
        return `${sign}$${value.toFixed(2)}`;
    }

    formatUTCDateTime(date) {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
    }

    enableJumpControls() {
        this.elements.jumpBtn.disabled = false;
        this.elements.jumpTime.disabled = false;
    }

    enablePlaybackControls() {
        this.elements.playBtn.disabled = false;
        this.elements.resetBtn.disabled = false;
        this.elements.speedControl.disabled = false;
        this.elements.speedPresetBtns.forEach(btn => btn.disabled = false);
    }

    updateStatus(message) {
        this.elements.status.textContent = message;
    }

    showTradeLog() {
        const trades = this.tradeSimulator.getCompletedTrades();
        const stats = this.tradeSimulator.getTradeStats();

        let html = '';

        if (trades.length === 0) {
            html = '<div class="empty-log">No completed trades yet. Place some trades to see them here!</div>';
        } else {
            html = '<table class="trade-log-table">';
            html += '<thead><tr>';
            html += '<th>#</th>';
            html += '<th>Direction</th>';
            html += '<th>Entry Time</th>';
            html += '<th>Entry Price</th>';
            html += '<th>Exit Time</th>';
            html += '<th>Exit Price</th>';
            html += '<th>Contracts</th>';
            html += '<th>P&L</th>';
            html += '</tr></thead>';
            html += '<tbody>';

            trades.forEach((trade, index) => {
                const pnlClass = trade.pnl >= 0 ? 'trade-positive' : 'trade-negative';
                const pnlSign = trade.pnl >= 0 ? '+' : '';
                
                html += '<tr>';
                html += `<td>${index + 1}</td>`;
                html += `<td>${trade.direction}</td>`;
                html += `<td>${this.formatDateTime(new Date(trade.entryTime))}</td>`;
                html += `<td>${trade.entryPrice.toFixed(2)}</td>`;
                html += `<td>${this.formatDateTime(new Date(trade.exitTime))}</td>`;
                html += `<td>${trade.exitPrice.toFixed(2)}</td>`;
                html += `<td>${trade.quantity}</td>`;
                html += `<td class="${pnlClass}">${pnlSign}${trade.pnl.toFixed(2)}</td>`;
                html += '</tr>';
            });

            html += '</tbody></table>';

            // Add stats
            html += '<div class="trade-stats">';
            html += '<div class="stat-item">';
            html += '<span class="stat-label">Total Trades</span>';
            html += `<span class="stat-value">${stats.totalTrades}</span>`;
            html += '</div>';
            html += '<div class="stat-item">';
            html += '<span class="stat-label">Winning Trades</span>';
            html += `<span class="stat-value" style="color: #4caf50">${stats.winningTrades}</span>`;
            html += '</div>';
            html += '<div class="stat-item">';
            html += '<span class="stat-label">Losing Trades</span>';
            html += `<span class="stat-value" style="color: #f44336">${stats.losingTrades}</span>`;
            html += '</div>';
            html += '<div class="stat-item">';
            html += '<span class="stat-label">Win Rate</span>';
            html += `<span class="stat-value">${stats.winRate.toFixed(1)}%</span>`;
            html += '</div>';
            html += '<div class="stat-item">';
            html += '<span class="stat-label">Total P&L</span>';
            const totalPnLClass = stats.totalPnL >= 0 ? '#4caf50' : '#f44336';
            const totalPnLSign = stats.totalPnL >= 0 ? '+' : '';
            html += `<span class="stat-value" style="color: ${totalPnLClass}">${totalPnLSign}${stats.totalPnL.toFixed(2)}</span>`;
            html += '</div>';
            html += '</div>';
        }

        this.elements.tradeLogContent.innerHTML = html;
        this.elements.tradeLogModal.style.display = 'block';
    }

    closeTradeLog() {
        this.elements.tradeLogModal.style.display = 'none';
    }

    formatDateTime(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const app = new TradeChartApp();
    await app.init();
});