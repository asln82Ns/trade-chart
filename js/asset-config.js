// Cache asset metadata fetched from /assets so other modules can read it
// synchronously after main.js loads.

let assets = {};   // symbol -> {symbol, name, description, tick_size, point_value, price_decimals}
let initialized = false;

export function setAssets(list) {
    assets = {};
    for (const a of list) assets[a.symbol] = a;
    initialized = true;
}

export function getAsset(symbol) {
    if (!initialized) throw new Error('asset config not yet initialized');
    const a = assets[symbol];
    if (!a) throw new Error(`Unknown asset: ${symbol}`);
    return a;
}

export function listAssetSymbols() {
    return Object.keys(assets);
}

export function isReady() { return initialized; }
