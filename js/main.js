// Main application entry point
import DBManager from './db-manager.js';
import CSVProcessor from './csv-processor.js';
import ChartController from './chart-controller.js';
import PlaybackEngine from './playback-engine.js';

class TradeChartApp {
    constructor() {
        this.dbManager = new DBManager();
        this.csvProcessor = null;
        this.chartController = null;
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
            status: document.getElementById('status'),
            currentTime: document.getElementById('currentTime'),
            currentOpen: document.getElementById('currentOpen'),
            currentHigh: document.getElementById('currentHigh'),
            currentLow: document.getElementById('currentLow'),
            currentClose: document.getElementById('currentClose'),
            barProgress: document.getElementById('barProgress'),
            loadedBars: document.getElementById('loadedBars'),
            chartContainer: document.getElementById('chartContainer')
        };

        this.chartController = new ChartController(this.elements.chartContainer);
        this.playbackEngine = new PlaybackEngine(this.chartController);

        this.playbackEngine.onTick((data) => {
            this.updatePlaybackInfo(data);
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
            
            const contextCount = Math.min(400, bars.length);
            const replayCount = Math.max(0, bars.length - 400);
            this.elements.loadedBars.textContent = `${bars.length} (${contextCount} context + ${replayCount} replay)`;
            this.updateStatus(`Loaded ${bars.length} bars`);
            
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
        this.updateStatus('Playing');
    }

    pause() {
        this.playbackEngine.pause();
        this.elements.playBtn.disabled = false;
        this.elements.pauseBtn.disabled = true;
        this.updateStatus('Paused');
    }

    reset() {
        this.playbackEngine.reset();
        this.elements.playBtn.disabled = false;
        this.elements.pauseBtn.disabled = true;
        this.updateStatus('Reset');
        this.elements.currentTime.textContent = '--';
        this.elements.currentOpen.textContent = '--';
        this.elements.currentHigh.textContent = '--';
        this.elements.currentLow.textContent = '--';
        this.elements.currentClose.textContent = '--';
        this.elements.barProgress.textContent = '--';
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
    }

    updateStatus(message) {
        this.elements.status.textContent = message;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const app = new TradeChartApp();
    await app.init();
});