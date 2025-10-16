// IndexedDB Manager for storing processed bar data
class DBManager {
    constructor() {
        this.dbName = 'TradeChartDB';
        this.version = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create bars store with timestamp index
                if (!db.objectStoreNames.contains('bars')) {
                    const barStore = db.createObjectStore('bars', { keyPath: 'timestamp' });
                    barStore.createIndex('timestamp', 'timestamp', { unique: true });
                }

                // Create metadata store
                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata', { keyPath: 'key' });
                }
            };
        });
    }

    async saveBars(bars) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bars'], 'readwrite');
            const store = transaction.objectStore('bars');

            let completed = 0;
            const total = bars.length;

            for (const bar of bars) {
                const request = store.put(bar);
                request.onsuccess = () => {
                    completed++;
                    if (completed === total) {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            }

            if (total === 0) resolve();
        });
    }

    async getBarsInRange(startTime, endTime) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bars'], 'readonly');
            const store = transaction.objectStore('bars');
            const index = store.index('timestamp');
            
            const range = IDBKeyRange.bound(startTime, endTime);
            const request = index.getAll(range);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllBars() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bars'], 'readonly');
            const store = transaction.objectStore('bars');
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getBarCount() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bars'], 'readonly');
            const store = transaction.objectStore('bars');
            const request = store.count();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async saveMetadata(key, value) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readwrite');
            const store = transaction.objectStore('metadata');
            const request = store.put({ key, value });

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getMetadata(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readonly');
            const store = transaction.objectStore('metadata');
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
    }

    async clearAll() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['bars', 'metadata'], 'readwrite');
            
            const barStore = transaction.objectStore('bars');
            const metaStore = transaction.objectStore('metadata');
            
            barStore.clear();
            metaStore.clear();

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async isDataProcessed() {
        const count = await this.getBarCount();
        return count > 0;
    }
}

export default DBManager;