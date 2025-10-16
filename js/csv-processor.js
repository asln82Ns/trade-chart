// CSV Processor - Parses CSV and groups trades into 5-minute bars
class CSVProcessor {
    constructor(dbManager) {
        this.dbManager = dbManager;
        this.bars = new Map();
        this.progressCallback = null;
        this.processedRows = 0;
    }

    setProgressCallback(callback) {
        this.progressCallback = callback;
    }

    roundToFiveMinutes(timestamp) {
        const minutes = timestamp.getUTCMinutes();
        const roundedMinutes = Math.floor(minutes / 5) * 5;
        const rounded = new Date(timestamp);
        rounded.setUTCMinutes(roundedMinutes, 0, 0);
        return rounded.getTime();
    }

    processFile(file) {
        return new Promise((resolve, reject) => {
            this.bars.clear();
            this.processedRows = 0;

            Papa.parse(file, {
                header: true,
                worker: true,
                skipEmptyLines: true,
                step: (result) => {
                    if (result.errors.length > 0) {
                        console.warn('Row parse errors:', result.errors);
                    }
                    
                    this.processRow(result.data);
                    this.processedRows++;

                    if (this.processedRows % 5000 === 0 && this.progressCallback) {
                        this.progressCallback(this.processedRows);
                    }
                },
                complete: async () => {
                    try {
                        console.log(`Processed ${this.processedRows} rows into ${this.bars.size} bars`);
                        
                        if (this.bars.size === 0) {
                            reject(new Error('No valid bars created. Check CSV format and date/price columns.'));
                            return;
                        }

                        this.sortBarTrades();

                        const barsArray = Array.from(this.bars.values())
                            .sort((a, b) => a.timestamp - b.timestamp);

                        await this.dbManager.saveBars(barsArray);
                        
                        await this.dbManager.saveMetadata('totalBars', barsArray.length);
                        await this.dbManager.saveMetadata('firstTimestamp', barsArray[0].timestamp);
                        await this.dbManager.saveMetadata('lastTimestamp', barsArray[barsArray.length - 1].timestamp);

                        resolve({
                            totalBars: barsArray.length,
                            firstTimestamp: barsArray[0].timestamp,
                            lastTimestamp: barsArray[barsArray.length - 1].timestamp,
                            totalRows: this.processedRows
                        });
                    } catch (error) {
                        reject(error);
                    }
                },
                error: (error) => {
                    console.error('Papa Parse error:', error);
                    reject(error);
                }
            });
        });
    }

    processRow(row) {
        let datetimeStr = row.datetime;
        
        datetimeStr = datetimeStr.replace(' ', 'T');
        datetimeStr = datetimeStr.replace(/\.(\d{3})\d+/, '.$1');
        
        const datetime = new Date(datetimeStr);
        if (isNaN(datetime.getTime())) {
            console.warn('Invalid date format:', row.datetime);
            return;
        }

        const price = parseFloat(row.price);
        if (isNaN(price)) {
            return;
        }

        const barTimestamp = this.roundToFiveMinutes(datetime);

        let bar = this.bars.get(barTimestamp);
        if (!bar) {
            bar = {
                timestamp: barTimestamp,
                open: price,
                high: price,
                low: price,
                close: price,
                trades: []
            };
            this.bars.set(barTimestamp, bar);
        }

        bar.high = Math.max(bar.high, price);
        bar.low = Math.min(bar.low, price);
        bar.close = price;

        bar.trades.push({
            time: datetime.getTime(),
            price: price
        });
    }

    sortBarTrades() {
        for (const bar of this.bars.values()) {
            bar.trades.sort((a, b) => a.time - b.time);
        }
    }
}

export default CSVProcessor;