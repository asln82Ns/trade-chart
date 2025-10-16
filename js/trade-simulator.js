// Trade Simulator - Handles position management and P&L calculation
class TradeSimulator {
    constructor() {
        this.position = 0; // positive = long, negative = short, 0 = flat
        this.avgEntryPrice = 0;
        this.realizedPnL = 0;
        this.unrealizedPnL = 0;
        this.totalPnL = 0;
        this.pendingOrders = []; // {type: 'buy'|'sell', timestamp, quantity, collectedTrades: []}
        this.pointValue = 20; // NQ: 1 point = $20 per contract
        this.slippageWindowMs = 200; // 200ms slippage window
        this.currentPrice = 0;
        this.onUpdateCallback = null;
        this.completedTrades = []; // Log of all completed round-trip trades
        this.currentEntryTime = 0; // Track entry time for current position
    }

    placeOrder(type, quantity, timestamp) {
        // Validate quantity
        if (quantity <= 0 || !Number.isInteger(quantity)) {
            throw new Error('Quantity must be a positive integer');
        }

        // Check if order would reverse position (not allowed)
        if (type === 'buy' && this.position < 0 && quantity > Math.abs(this.position)) {
            throw new Error('Cannot reverse position. Close short position first (flatten to 0).');
        }
        if (type === 'sell' && this.position > 0 && quantity > this.position) {
            throw new Error('Cannot reverse position. Close long position first (flatten to 0).');
        }

        // Add order to pending queue
        const order = {
            type: type,
            quantity: quantity,
            timestamp: timestamp,
            collectedTrades: [],
            executed: false
        };

        this.pendingOrders.push(order);
        console.log(`Order placed: ${type.toUpperCase()} ${quantity} @ ${new Date(timestamp).toISOString()}`);
    }

    processTick(trade) {
        // Update current price for unrealized P&L
        this.currentPrice = trade.price;

        // Process pending orders
        for (let i = this.pendingOrders.length - 1; i >= 0; i--) {
            const order = this.pendingOrders[i];
            
            if (order.executed) continue;

            const elapsed = trade.time - order.timestamp;

            // Collect trades within 200ms window
            if (elapsed >= 0 && elapsed <= this.slippageWindowMs) {
                order.collectedTrades.push(trade.price);
            }

            // Execute order after 200ms window
            if (elapsed > this.slippageWindowMs && !order.executed) {
                this.executeOrder(order);
                order.executed = true;
                // Remove executed orders
                this.pendingOrders.splice(i, 1);
            }
        }

        // Update unrealized P&L
        this.updateUnrealizedPnL();
        this.updateTotalPnL();

        if (this.onUpdateCallback) {
            this.onUpdateCallback(this.getState());
        }
    }

    executeOrder(order) {
        if (order.collectedTrades.length === 0) {
            console.warn('No trades collected in slippage window, using order timestamp price');
            // This shouldn't happen in normal playback, but handle edge case
            return;
        }

        // Get worst price in window
        let fillPrice;
        if (order.type === 'buy') {
            // Buying: worst = highest price
            fillPrice = Math.max(...order.collectedTrades);
        } else {
            // Selling: worst = lowest price
            fillPrice = Math.min(...order.collectedTrades);
        }

        console.log(`Order executed: ${order.type.toUpperCase()} ${order.quantity} @ ${fillPrice.toFixed(2)} (collected ${order.collectedTrades.length} ticks)`);

        // Update position and P&L
        if (order.type === 'buy') {
            this.executeBuy(order.quantity, fillPrice);
        } else {
            this.executeSell(order.quantity, fillPrice);
        }
    }

    executeBuy(quantity, fillPrice) {
        if (this.position < 0) {
            // Closing short position
            const closeQuantity = Math.min(quantity, Math.abs(this.position));
            const pnl = (this.avgEntryPrice - fillPrice) * closeQuantity * this.pointValue;
            this.realizedPnL += pnl;
            
            // Log completed trade
            this.completedTrades.push({
                direction: 'SHORT',
                entryTime: this.currentEntryTime,
                entryPrice: this.avgEntryPrice,
                exitTime: Date.now(),
                exitPrice: fillPrice,
                quantity: closeQuantity,
                pnl: pnl
            });
            
            this.position += closeQuantity;
            
            console.log(`Closed ${closeQuantity} short @ ${fillPrice.toFixed(2)}, Realized P&L: $${pnl.toFixed(2)}`);

            // If quantity exceeds short position, open long with remaining
            if (quantity > closeQuantity) {
                const remainingQty = quantity - closeQuantity;
                this.position = remainingQty;
                this.avgEntryPrice = fillPrice;
                this.currentEntryTime = Date.now();
                console.log(`Opened ${remainingQty} long @ ${fillPrice.toFixed(2)}`);
            } else if (this.position === 0) {
                this.avgEntryPrice = 0;
                this.currentEntryTime = 0;
            }
        } else if (this.position === 0) {
            // Opening new long position
            this.position = quantity;
            this.avgEntryPrice = fillPrice;
            this.currentEntryTime = Date.now();
            console.log(`Opened ${quantity} long @ ${fillPrice.toFixed(2)}`);
        } else {
            // Adding to existing long position - calculate weighted average
            const totalCost = (this.avgEntryPrice * this.position) + (fillPrice * quantity);
            this.position += quantity;
            this.avgEntryPrice = totalCost / this.position;
            console.log(`Added ${quantity} long @ ${fillPrice.toFixed(2)}, Avg Entry: ${this.avgEntryPrice.toFixed(2)}, Position: ${this.position}`);
        }
    }

    executeSell(quantity, fillPrice) {
        if (this.position > 0) {
            // Closing long position
            const closeQuantity = Math.min(quantity, this.position);
            const pnl = (fillPrice - this.avgEntryPrice) * closeQuantity * this.pointValue;
            this.realizedPnL += pnl;
            
            // Log completed trade
            this.completedTrades.push({
                direction: 'LONG',
                entryTime: this.currentEntryTime,
                entryPrice: this.avgEntryPrice,
                exitTime: Date.now(),
                exitPrice: fillPrice,
                quantity: closeQuantity,
                pnl: pnl
            });
            
            this.position -= closeQuantity;
            
            console.log(`Closed ${closeQuantity} long @ ${fillPrice.toFixed(2)}, Realized P&L: $${pnl.toFixed(2)}`);

            // If quantity exceeds long position, open short with remaining
            if (quantity > closeQuantity) {
                const remainingQty = quantity - closeQuantity;
                this.position = -remainingQty;
                this.avgEntryPrice = fillPrice;
                this.currentEntryTime = Date.now();
                console.log(`Opened ${remainingQty} short @ ${fillPrice.toFixed(2)}`);
            } else if (this.position === 0) {
                this.avgEntryPrice = 0;
                this.currentEntryTime = 0;
            }
        } else if (this.position === 0) {
            // Opening new short position
            this.position = -quantity;
            this.avgEntryPrice = fillPrice;
            this.currentEntryTime = Date.now();
            console.log(`Opened ${quantity} short @ ${fillPrice.toFixed(2)}`);
        } else {
            // Adding to existing short position - calculate weighted average
            const totalCost = (this.avgEntryPrice * Math.abs(this.position)) + (fillPrice * quantity);
            this.position -= quantity;
            this.avgEntryPrice = totalCost / Math.abs(this.position);
            console.log(`Added ${quantity} short @ ${fillPrice.toFixed(2)}, Avg Entry: ${this.avgEntryPrice.toFixed(2)}, Position: ${this.position}`);
        }
    }

    updateUnrealizedPnL() {
        if (this.position === 0) {
            this.unrealizedPnL = 0;
            return;
        }

        if (this.position > 0) {
            // Long position: profit when price goes up
            this.unrealizedPnL = (this.currentPrice - this.avgEntryPrice) * this.position * this.pointValue;
        } else {
            // Short position: profit when price goes down
            this.unrealizedPnL = (this.avgEntryPrice - this.currentPrice) * Math.abs(this.position) * this.pointValue;
        }
    }

    updateTotalPnL() {
        this.totalPnL = this.realizedPnL + this.unrealizedPnL;
    }

    getState() {
        return {
            position: this.position,
            avgEntryPrice: this.avgEntryPrice,
            currentPrice: this.currentPrice,
            realizedPnL: this.realizedPnL,
            unrealizedPnL: this.unrealizedPnL,
            totalPnL: this.totalPnL,
            pendingOrders: this.pendingOrders.length
        };
    }

    reset() {
        this.position = 0;
        this.avgEntryPrice = 0;
        this.realizedPnL = 0;
        this.unrealizedPnL = 0;
        this.totalPnL = 0;
        this.currentPrice = 0;
        this.pendingOrders = [];
        this.completedTrades = [];
        this.currentEntryTime = 0;
        
        if (this.onUpdateCallback) {
            this.onUpdateCallback(this.getState());
        }
        
        console.log('Trade simulator reset');
    }

    onUpdate(callback) {
        this.onUpdateCallback = callback;
    }

    canPlaceOrder() {
        // Orders can be placed anytime during playback
        return true;
    }

    getCompletedTrades() {
        return this.completedTrades;
    }

    getTradeStats() {
        if (this.completedTrades.length === 0) {
            return {
                totalTrades: 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: 0,
                totalPnL: 0
            };
        }

        const winningTrades = this.completedTrades.filter(t => t.pnl > 0).length;
        const losingTrades = this.completedTrades.filter(t => t.pnl < 0).length;
        const totalPnL = this.completedTrades.reduce((sum, t) => sum + t.pnl, 0);
        const winRate = (winningTrades / this.completedTrades.length) * 100;

        return {
            totalTrades: this.completedTrades.length,
            winningTrades: winningTrades,
            losingTrades: losingTrades,
            winRate: winRate,
            totalPnL: totalPnL
        };
    }
}

export default TradeSimulator;