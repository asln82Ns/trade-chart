// TradeSimulator — position management + P&L for the active asset.
//
// Slippage with 1s tape: when an order is placed, we collect the highs (for
// buys) and lows (for sells) of the next ~200ms worth of 1s bars, then fill
// at the worst price within that window. Because our tape resolution is 1s,
// any 200ms window will fall inside a single 1s bar most of the time, so the
// effective slippage = bar.high (buy) or bar.low (sell) of the bar containing
// the placement instant.
//
// Stop market orders: pendingStops are evaluated at the top of every 1s tick.
// A buy stop triggers when bar.high >= stopPrice; a sell stop when
// bar.low <= stopPrice. On trigger, the stop is converted to a market order
// via the same placeOrder flow real BUY/SELL clicks use — the existing
// 200ms slippage window then captures the trigger bar's high/low (worst-case
// fill while the order is being routed) and the next bar's high/low (fill
// latency bleeding past the 1s boundary). One fill path for both manual
// markets and triggered stops keeps the simulator pessimistic and consistent.

const SLIPPAGE_WINDOW_MS = 200;

class TradeSimulator {
    constructor() {
        this.position = 0;
        this.avgEntryPrice = 0;
        this.realizedPnL = 0;
        this.unrealizedPnL = 0;
        this.totalPnL = 0;
        this.pendingOrders = [];
        this.pendingStops = [];
        this._nextStopId = 1;
        this.pointValue = 20;        // overridden via setAsset
        this.tickSize = 0.25;
        this.priceDecimals = 2;
        this.qtyIncrement = 1;       // smallest sizing step (e.g. 0.1, 0.2, 1)
        this.currentPrice = 0;
        this.currentSecondUnix = 0;
        this.currentEntryTime = 0;
        // Chart context stamped onto each completed trade so the trade log /
        // CSV export records the timeframe the chart was on and the contract
        // month that was active when the trade closed.
        this.timeframeMin = 0;
        this.currentContract = null;
        this.completedTrades = [];
        this.onUpdateCallback = null;
        this.onStopsChangedCallback = null;
    }

    setAsset(asset) {
        this.pointValue = asset.point_value;
        this.tickSize = asset.tick_size;
        this.priceDecimals = asset.price_decimals;
        this.qtyIncrement = asset.min_qty_increment ?? 1;
    }

    /** True iff qty is a positive integer multiple of qtyIncrement. Tolerant
     *  of float drift (0.1 + 0.2 = 0.30000…4) via 1e-9 epsilon on the modulo. */
    _validQty(qty) {
        if (!Number.isFinite(qty) || qty <= 0) return false;
        const ratio = qty / this.qtyIncrement;
        return Math.abs(ratio - Math.round(ratio)) < 1e-9;
    }

    /** Snap position to the increment grid. Eliminates float drift from a
     *  chain of 0.1 fills (0.1+0.1+0.1 → 0.30000000000000004 → 0.3). */
    _quantizePosition() {
        // Round to 1e-4 — finer than any reasonable increment (smallest
        // supported is 0.1) so it never alters legitimate values.
        this.position = Math.round(this.position * 10000) / 10000;
    }

    /** Float-safe "position is flat". Mid-fill, this.position can be 1e-17
     *  away from zero from offsetting += / -= operations; the inline
     *  `=== 0` checks would miss it. */
    _isFlat() { return Math.abs(this.position) < 1e-9; }

    placeOrder(type, quantity, unixSec) {
        if (!this._validQty(quantity)) {
            throw new Error(`Quantity must be a positive multiple of ${this.qtyIncrement}`);
        }
        if (type === 'buy' && this.position < 0 && quantity > Math.abs(this.position)) {
            throw new Error('Cannot reverse position. Close short first (flatten to 0).');
        }
        if (type === 'sell' && this.position > 0 && quantity > this.position) {
            throw new Error('Cannot reverse position. Close long first (flatten to 0).');
        }
        this.pendingOrders.push({
            type, quantity,
            placedUnixMs: unixSec * 1000,
            // Seed the window with the current price so even if the next 1s bar
            // is past the placement time we still have a sane fill.
            highs: [this.currentPrice],
            lows: [this.currentPrice],
        });
        console.log(`Order placed: ${type.toUpperCase()} ${quantity} @ unix ${unixSec}`);
    }

    placeStopOrder(type, quantity, stopPrice) {
        if (type !== 'buy' && type !== 'sell') {
            throw new Error('Stop type must be buy or sell');
        }
        if (!this._validQty(quantity)) {
            throw new Error(`Quantity must be a positive multiple of ${this.qtyIncrement}`);
        }
        if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
            throw new Error('Stop price must be a positive number');
        }
        if (this.currentPrice <= 0) {
            throw new Error('No current price yet — start playback before placing stops');
        }
        // Round to nearest tick.
        const ticks = Math.round(stopPrice / this.tickSize);
        const rounded = +(ticks * this.tickSize).toFixed(this.priceDecimals);
        if (type === 'buy' && rounded <= this.currentPrice) {
            throw new Error(`Buy stop must be above current price (${this.currentPrice.toFixed(this.priceDecimals)})`);
        }
        if (type === 'sell' && rounded >= this.currentPrice) {
            throw new Error(`Sell stop must be below current price (${this.currentPrice.toFixed(this.priceDecimals)})`);
        }
        const stop = { id: this._nextStopId++, type, quantity, stopPrice: rounded };
        this.pendingStops.push(stop);
        console.log(`Stop placed: ${type.toUpperCase()} STOP ${quantity} @ ${rounded.toFixed(this.priceDecimals)} (id ${stop.id})`);
        if (this.onStopsChangedCallback) this.onStopsChangedCallback(this.pendingStops.slice());
        return stop;
    }

    /** Cancel every working order (in-flight market + resting stops) and close
     *  any open position with a market order at the current second. The close
     *  routes through placeOrder() so the existing 200ms slippage window applies
     *  and the fill flows through _fillBuy/_fillSell — completedTrades log,
     *  avgEntry, and PnL math reuse the same path BUY/SELL clicks use. */
    flatten() {
        this.pendingOrders = [];
        const hadStops = this.pendingStops.length > 0;
        this.pendingStops = [];
        if (hadStops && this.onStopsChangedCallback) {
            this.onStopsChangedCallback([]);
        }
        if (this._isFlat()) return;
        const closeType = this.position > 0 ? 'sell' : 'buy';
        const closeQty = Math.abs(this.position);
        this.placeOrder(closeType, closeQty, this.currentSecondUnix);
    }

    cancelStopOrder(id) {
        const idx = this.pendingStops.findIndex(s => s.id === id);
        if (idx < 0) return false;
        const removed = this.pendingStops.splice(idx, 1)[0];
        console.log(`Stop cancelled: id ${removed.id} (${removed.type.toUpperCase()} ${removed.quantity} @ ${removed.stopPrice.toFixed(this.priceDecimals)})`);
        if (this.onStopsChangedCallback) this.onStopsChangedCallback(this.pendingStops.slice());
        return true;
    }

    /** Called for each 1s tape tick while playing. */
    processSecond({ t, price, high, low, volume, k }) {
        this.currentSecondUnix = t;
        this.currentPrice = price;
        if (k) this.currentContract = k;

        // Evaluate stop triggers FIRST so a triggered stop becomes a pending
        // market order BEFORE the existing slippage loop runs below — this
        // tick's high/low then enters its slippage window naturally.
        let stopsFired = false;
        for (let i = this.pendingStops.length - 1; i >= 0; i--) {
            const s = this.pendingStops[i];
            const triggered = s.type === 'buy' ? high >= s.stopPrice : low <= s.stopPrice;
            if (!triggered) continue;
            try {
                this.placeOrder(s.type, s.quantity, t);
                console.log(`Stop triggered: ${s.type.toUpperCase()} STOP ${s.quantity} @ ${s.stopPrice.toFixed(this.priceDecimals)} (id ${s.id}) → market order pending fill`);
            } catch (e) {
                // Position-reversal at trigger time. Drop the stop with a
                // warning rather than partially fill or silently retry.
                console.warn(`Stop id ${s.id} (${s.type.toUpperCase()} ${s.quantity} @ ${s.stopPrice.toFixed(this.priceDecimals)}) triggered but rejected: ${e.message}`);
            }
            this.pendingStops.splice(i, 1);
            stopsFired = true;
        }
        if (stopsFired && this.onStopsChangedCallback) {
            this.onStopsChangedCallback(this.pendingStops.slice());
        }

        for (let i = this.pendingOrders.length - 1; i >= 0; i--) {
            const o = this.pendingOrders[i];
            const elapsedMs = t * 1000 - o.placedUnixMs;
            // Collect within the slippage window (inclusive at 0, plus a 1s buffer
            // so a window that straddles a 1s boundary captures both bars).
            if (elapsedMs >= 0 && elapsedMs <= SLIPPAGE_WINDOW_MS + 1000) {
                o.highs.push(high);
                o.lows.push(low);
            }
            if (elapsedMs > SLIPPAGE_WINDOW_MS) {
                this._executeOrder(o);
                this.pendingOrders.splice(i, 1);
            }
        }
        this._updatePnL();
        if (this.onUpdateCallback) this.onUpdateCallback(this.getState());
    }

    _executeOrder(order) {
        const fill = order.type === 'buy' ? Math.max(...order.highs) : Math.min(...order.lows);
        console.log(`Order executed: ${order.type.toUpperCase()} ${order.quantity} @ ${fill.toFixed(this.priceDecimals)}`);
        if (order.type === 'buy') this._fillBuy(order.quantity, fill);
        else this._fillSell(order.quantity, fill);
    }

    _fillBuy(qty, fill) {
        if (this.position < 0) {
            const closeQty = Math.min(qty, -this.position);
            const pnl = (this.avgEntryPrice - fill) * closeQty * this.pointValue;
            this.realizedPnL += pnl;
            this.completedTrades.push({
                direction: 'SHORT',
                entryTime: this.currentEntryTime,
                entryPrice: this.avgEntryPrice,
                exitTime: this.currentSecondUnix,
                exitPrice: fill,
                quantity: closeQty,
                pnl,
                timeframeMin: this.timeframeMin,
                contract: this.currentContract,
            });
            this.position += closeQty;
            if (qty > closeQty) {
                const rem = qty - closeQty;
                this.position = rem;
                this.avgEntryPrice = fill;
                this.currentEntryTime = this.currentSecondUnix;
            } else if (this._isFlat()) {
                this.avgEntryPrice = 0;
                this.currentEntryTime = 0;
            }
        } else if (this._isFlat()) {
            this.position = qty;
            this.avgEntryPrice = fill;
            this.currentEntryTime = this.currentSecondUnix;
        } else {
            const totalCost = this.avgEntryPrice * this.position + fill * qty;
            this.position += qty;
            this.avgEntryPrice = totalCost / this.position;
        }
        this._quantizePosition();
    }

    _fillSell(qty, fill) {
        if (this.position > 0) {
            const closeQty = Math.min(qty, this.position);
            const pnl = (fill - this.avgEntryPrice) * closeQty * this.pointValue;
            this.realizedPnL += pnl;
            this.completedTrades.push({
                direction: 'LONG',
                entryTime: this.currentEntryTime,
                entryPrice: this.avgEntryPrice,
                exitTime: this.currentSecondUnix,
                exitPrice: fill,
                quantity: closeQty,
                pnl,
                timeframeMin: this.timeframeMin,
                contract: this.currentContract,
            });
            this.position -= closeQty;
            if (qty > closeQty) {
                const rem = qty - closeQty;
                this.position = -rem;
                this.avgEntryPrice = fill;
                this.currentEntryTime = this.currentSecondUnix;
            } else if (this._isFlat()) {
                this.avgEntryPrice = 0;
                this.currentEntryTime = 0;
            }
        } else if (this._isFlat()) {
            this.position = -qty;
            this.avgEntryPrice = fill;
            this.currentEntryTime = this.currentSecondUnix;
        } else {
            const totalCost = this.avgEntryPrice * Math.abs(this.position) + fill * qty;
            this.position -= qty;
            this.avgEntryPrice = totalCost / Math.abs(this.position);
        }
        this._quantizePosition();
    }

    _updatePnL() {
        if (this._isFlat()) {
            this.unrealizedPnL = 0;
        } else if (this.position > 0) {
            this.unrealizedPnL = (this.currentPrice - this.avgEntryPrice) * this.position * this.pointValue;
        } else {
            this.unrealizedPnL = (this.avgEntryPrice - this.currentPrice) * Math.abs(this.position) * this.pointValue;
        }
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
            pendingOrders: this.pendingOrders.length,
            pendingStops: this.pendingStops.slice(),
        };
    }

    getPendingStops() { return this.pendingStops.slice(); }

    /** Flatten position + cancel working orders.
     *  keepHistory=true preserves completedTrades (used by the Reset button so
     *  a replay session's cumulative trade log survives a re-play of the same
     *  scenario); realizedPnL is then re-derived from the surviving trades.
     *  keepHistory=false wipes everything (used when loading a new asset/date). */
    reset(keepHistory = false) {
        this.position = 0;
        this.avgEntryPrice = 0;
        this.unrealizedPnL = 0;
        this.currentPrice = 0;
        this.currentSecondUnix = 0;
        this.currentEntryTime = 0;
        this.pendingOrders = [];
        const hadStops = this.pendingStops.length > 0;
        this.pendingStops = [];
        if (keepHistory) {
            this.realizedPnL = this.completedTrades.reduce((s, t) => s + t.pnl, 0);
        } else {
            this.completedTrades = [];
            this.realizedPnL = 0;
        }
        this.totalPnL = this.realizedPnL;
        if (this.onUpdateCallback) this.onUpdateCallback(this.getState());
        if (hadStops && this.onStopsChangedCallback) this.onStopsChangedCallback([]);
    }

    onUpdate(cb) { this.onUpdateCallback = cb; }
    onStopsChanged(cb) { this.onStopsChangedCallback = cb; }

    getCompletedTrades() { return this.completedTrades; }

    /** Replace the completed-trade log with a previously-saved one (resume a
     *  persisted replay session). realizedPnL is re-derived so the trade-info
     *  panel reflects the restored cumulative result. */
    restoreTrades(trades) {
        this.completedTrades = Array.isArray(trades) ? trades.slice() : [];
        this.realizedPnL = this.completedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
        this.totalPnL = this.realizedPnL + this.unrealizedPnL;
        if (this.onUpdateCallback) this.onUpdateCallback(this.getState());
    }
}

export default TradeSimulator;
