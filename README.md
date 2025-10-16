# Trade Chart

A lightweight, browser-based trading data visualizer with tick-by-tick replay and **live trade simulation** functionality.

## Features

- **5-Minute OHLC Bars**: Automatically groups trade data into 5-minute bars
- **Tick-by-Tick Replay**: Watch every price movement as it happened in real-time
- **Trade Simulation**: Place buy/sell market orders with realistic 200ms slippage
- **Real-Time P&L**: Track realized and unrealized profit/loss as prices move
- **Position Management**: Build and close positions with multiple entries
- **Speed Control**: Adjust playback speed from 10 to 5,000 ticks per second
- **Jump to Timestamp**: Load any time period with 400 bars of historical context
- **UTC Time Display**: All timestamps shown in UTC with no conversion
- **Large File Support**: Efficiently handles 3GB+ CSV files through IndexedDB caching

## Project Structure

```
trade-chart/
├── index.html              
├── css/
│   └── styles.css          
├── js/
│   ├── main.js             
│   ├── db-manager.js       
│   ├── csv-processor.js    
│   ├── chart-controller.js 
│   ├── playback-engine.js  
│   └── trade-simulator.js  (NEW)
├── data.csv                
└── README.md               
```

## Setup

### Requirements
- Modern web browser (Chrome, Firefox, Edge, Safari)
- Local web server (required for ES6 modules)

### Installation

1. Clone or download this repository
2. Place your `data.csv` file in the project root directory
3. **Start a local web server** (choose one method):

   **Option A: Python (if installed)**
   ```bash
   cd trade-chart
   python -m http.server 8000
   ```
   Then open: `http://localhost:8000`

   **Option B: Node.js (if installed)**
   ```bash
   cd trade-chart
   npx serve
   ```
   Then open the URL shown in terminal

   **Option C: VS Code (if using)**
   - Install "Live Server" extension
   - Right-click `index.html`
   - Select "Open with Live Server"

4. The application will open in your browser

**Important**: You cannot simply double-click `index.html` due to browser security restrictions on ES6 modules. A local server is required.

## CSV Format

Your `data.csv` should have the following format:

```csv
datetime,ticker,price,size,session_end_date,timestamp
2025-06-01 22:00:00.068958624+00:00,NQM5,21303.75,30,2025-06-01,1748815200068958624
```

**Required columns:**
- `datetime`: UTC timestamp with timezone (ISO 8601 format)
- `price`: Trade price (float)

**Note**: Other columns (ticker, size, session_end_date, timestamp) are preserved but not currently used.

## Usage

### First Time Setup (One-time process)

1. Click **"Choose File"** and select your `data.csv`
2. Click **"Process Data"**
3. Wait 2-5 minutes while the CSV is processed (progress bar shows status)
4. Data is cached in your browser's IndexedDB for instant access later

### Loading Data

1. Enter a **UTC timestamp** in the format: `YYYY-MM-DD HH:MM:SS`
   - **Important**: Enter the time in UTC, not your local timezone
   - Example: If your data shows `2025-06-04 10:30:00 UTC`, enter exactly that
2. Click **"Load"**
3. The system loads **400 bars BEFORE** your timestamp for context
4. Chart displays these 400 bars as completed OHLC (historical context)
5. All remaining bars until end of dataset are loaded for tick-by-tick replay

### Playback Controls

- **Play**: Starts replaying bars tick-by-tick from the 400-bar context point
- **Pause**: Pause playback at current position
- **Reset**: Return to initial state (400 context bars visible, P&L reset)
- **Speed Slider**: Adjust from 10 to 5,000 ticks per second

### Trade Simulation (NEW)

#### Placing Orders

1. **Set Quantity**: Enter number of contracts (default: 1)
2. **During Playback Only**: Buy/Sell buttons are enabled only when playing
3. **Click BUY or SELL**: Order is placed at current tick timestamp
4. **200ms Slippage Simulation**: 
   - System collects all trade prices for next 200ms
   - BUY fills at **highest price** in window (worst case)
   - SELL fills at **lowest price** in window (worst case)
5. **Order Confirmation**: Check browser console for fill details

#### Position Management Rules

- **Directional Restriction**: Must flatten position before reversing
  - Example: LONG 10 → must SELL 10 to go flat → can then go SHORT
  - Blocked: LONG 10 → SELL 15 ❌ (trying to reverse to SHORT 5)
  
- **Multiple Entries Allowed**: Can add to existing position
  - Example: BUY 5 @ 21300 → BUY 10 @ 21305
  - System calculates weighted average entry: 21303.33
  - Position: LONG 15 @ avg 21303.33

- **Partial Closes**: Can close portions of position
  - Example: LONG 20 → SELL 8 → LONG 12 remaining

#### P&L Calculation

- **Point Value**: NQ standard = $20 per point per contract
- **Unrealized P&L**: 
  - LONG: (Current Price - Avg Entry) × Position × $20
  - SHORT: (Avg Entry - Current Price) × Position × $20
- **Realized P&L**: Accumulated from all closed trades
- **Total P&L**: Realized + Unrealized (updates every tick)

#### P&L Persistence

- **Persists Through**: Play/Pause actions
- **Resets On**: 
  - Reset button click
  - Load button click (new time range)
- **Real-Time Updates**: P&L updates every tick during playback

#### Display Information

Trade info panel shows:
- **Position**: FLAT / LONG X / SHORT X
- **Avg Entry**: Average entry price of current position
- **Realized P&L**: Profit/loss from closed trades
- **Unrealized P&L**: Current position's floating P&L
- **Total P&L**: Sum of realized + unrealized (color coded: green/red)

### Replay Behavior

1. **Initial State**: Chart shows 400 completed historical bars for context
2. **Press Play**: Starts replaying remaining bars tick-by-tick
3. **Replay**: New bars appear and grow at the END of the chart (like real-time)
4. **Building Bars**: Watch each bar form as trades are processed
5. **Speed**: 10-5,000 ticks per second (configurable via slider)
6. **Trading**: Place orders during playback only (buttons disabled when paused)
7. **Completion**: When all bars processed, replay stops
8. **Press Reset**: Returns to initial state (clears P&L and chart)

## Technical Details

### Trade Simulation Architecture

1. **Pending Order Queue**: FIFO queue stores orders with placement timestamp
2. **Slippage Window**: 200ms collection period after order placement
3. **Worst-Case Execution**: Buy = highest tick, Sell = lowest tick in window
4. **Position Tracking**: Maintains quantity, direction, and average entry price
5. **P&L Engine**: Calculates realized (on close) and unrealized (mark-to-market) P&L
6. **Tick Processing**: Every trade updates unrealized P&L and checks pending orders

### Data Processing

1. **CSV Parsing**: Uses PapaParse to stream large files
2. **Bar Grouping**: Groups trades into 5-minute intervals based on UTC time
3. **Trade Preservation**: Each bar stores array of individual trades with timestamps
4. **Storage**: Saves processed bars to IndexedDB (~50MB for 6 months of data)
5. **Retrieval**: Instant loading via indexed timestamp queries

### Memory Usage

- **Processing**: Streams CSV in chunks (minimal memory impact)
- **Playback**: Keeps all loaded bars in memory (400 context + all replay bars)
- **Chart**: Renders visible bars only (~200 at a time)
- **Trade Simulator**: Minimal overhead (~1KB per pending order)

### Performance

- **Rendering**: 30 FPS with requestAnimationFrame
- **Tick Processing**: 10-5,000 ticks per second (configurable)
- **Data Access**: <100ms to load bars from IndexedDB
- **Chart Updates**: Uses Lightweight Charts' update() API (optimized for real-time)
- **Order Execution**: <1ms per order fill calculation

## Browser Compatibility

✅ Chrome 90+  
✅ Firefox 88+  
✅ Edge 90+  
✅ Safari 14+  

All modern browsers with IndexedDB and ES6 module support.

## Troubleshooting

### "CORS policy" or "ERR_FAILED" errors
- **Cause**: Trying to open `index.html` directly (file:// protocol)
- **Solution**: Must use a local web server (see Setup section)
- **Why**: Browsers block ES6 modules from file:// for security

### "No data found for this time range"
- Verify your timestamp is within the range of your CSV data
- Check that data has been processed (click "Process Data" first)

### "Cannot reverse position" error
- System blocks going from LONG to SHORT (or vice versa) in one order
- Solution: Close your position first (go flat), then open opposite direction

### Progress bar stuck during processing
- Check browser console for errors
- Ensure CSV format matches expected format
- Try a smaller sample file first

### Chart not displaying
- Open browser console (F12) to check for errors
- Verify `data.csv` is in the correct format
- Clear browser cache and IndexedDB, then reprocess

### Performance issues
- Reduce playback speed
- Use a smaller time range (fewer bars)
- Close other browser tabs

## Example Trading Session

```
1. Load data: 2025-06-04 10:00:00
2. Press Play
3. Set Quantity: 5
4. Click BUY when price looks good
   → Order placed at 21305.25
   → Fills at 21305.75 (worst price in 200ms)
   → Position: LONG 5 @ 21305.75
5. Watch P&L update in real-time as price moves
6. Price moves up to 21310.00
   → Unrealized P&L: +$425 [(21310 - 21305.75) × 5 × $20]
7. Add to position: Click BUY, Quantity: 10
   → Fills at 21310.50
   → Position: LONG 15 @ 21308.67 (weighted avg)
8. Price drops to 21302.00
   → Total P&L: -$500 [(21302 - 21308.67) × 15 × $20]
9. Close position: Click SELL, Quantity: 15
   → Fills at 21301.75
   → Realized P&L: -$515.75
   → Position: FLAT
```

## Future Enhancements

- [ ] Stop-loss and take-profit orders
- [ ] Limit orders with order book simulation
- [ ] Multiple timeframes (1-min, 15-min, etc.)
- [ ] Volume display
- [ ] Trade log/journal export
- [ ] Position sizing calculator
- [ ] Keyboard shortcuts for quick trading
- [ ] Risk metrics (max drawdown, Sharpe ratio)

## Technology Stack

- **UI**: Pure HTML/CSS/JavaScript (no frameworks)
- **Charting**: Lightweight Charts v4.1.3 (via CDN)
- **CSV Parsing**: PapaParse v5.4.1 (via CDN)
- **Storage**: IndexedDB (native browser API)
- **Server**: Any local web server (required for ES6 modules)

**Total Code**: ~1,600 lines  
**Dependencies**: 2 (both via CDN)  
**Build Tools**: None  
**Setup**: Start local server, open browser

## License

MIT License - Free to use and modify

## Support

For issues or questions, check the browser console for error messages and verify your CSV format matches the specification above.