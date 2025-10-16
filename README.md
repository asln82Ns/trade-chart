# Trade Chart

A lightweight, browser-based trading data visualizer that displays OHLC charts with tick-by-tick replay functionality.

## Features

- **5-Minute OHLC Bars**: Automatically groups trade data into 5-minute bars
- **Tick-by-Tick Replay**: Watch every price movement as it happened in real-time
- **Speed Control**: Adjust playback speed from 5 to 50 ticks per second
- **Jump to Timestamp**: Load any time period with 400 bars of historical context + 200 bars for replay
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
│   └── playback-engine.js  
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
3. The system loads **400 bars BEFORE + 200 bars AFTER** your timestamp = 600 total
4. Chart displays the first 400 bars as completed OHLC (historical context)
5. The remaining 200 bars are ready for tick-by-tick replay when you press Play

### Playback Controls

- **Play**: Starts replaying the next 200 bars tick-by-tick
- **Pause**: Pause playback at current position
- **Reset**: Return to initial state (400 context bars visible)
- **Speed Slider**: Adjust from 5 to 50 ticks per second

### Replay Behavior

1. **Initial State**: Chart shows 400 completed historical bars for context
2. **Press Play**: Starts replaying the next 200 bars tick-by-tick
3. **Replay**: New bars appear and grow at the END of the chart (like real-time)
4. **Building Bars**: Watch each bar form as trades are processed
5. **Speed**: 5-50 ticks per second (configurable via slider)
6. **Completion**: When all 200 bars processed, replay stops
7. **Press Reset**: Returns to initial state (400 context bars visible)

### Information Display

The top panel shows:
- **Current Time**: UTC timestamp of current bar
- **Price**: Current trade price
- **Bar Progress**: How many trades completed in current 5-minute bar
- **Loaded Bars**: Total bars (context + replay count)

## Technical Details

### Data Processing

1. **CSV Parsing**: Uses PapaParse to stream large files
2. **Bar Grouping**: Groups trades into 5-minute intervals based on UTC time
3. **Storage**: Saves processed bars to IndexedDB (~50MB for 6 months of data)
4. **Retrieval**: Instant loading via indexed timestamp queries

### Memory Usage

- **Processing**: Streams CSV in chunks (minimal memory impact)
- **Playback**: Keeps ~600 bars in memory (400 context + 200 replay) (~30-50MB)
- **Chart**: Renders visible bars only (~200 at a time)

### Performance

- **Rendering**: 30 FPS with requestAnimationFrame
- **Tick Processing**: 5-50 ticks per second (configurable)
- **Data Access**: <100ms to load 600 bars from IndexedDB
- **Chart Updates**: Uses Lightweight Charts' update() API (optimized for real-time)

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

## Future Enhancements

- [ ] Trading simulation (buy/sell buttons)
- [ ] P&L tracking
- [ ] Multiple timeframes (1-min, 15-min, etc.)
- [ ] Volume display
- [ ] Export/import data ranges
- [ ] Keyboard shortcuts

## Technology Stack

- **UI**: Pure HTML/CSS/JavaScript (no frameworks)
- **Charting**: Lightweight Charts v4.1.3 (via CDN)
- **CSV Parsing**: PapaParse v5.4.1 (via CDN)
- **Storage**: IndexedDB (native browser API)
- **Server**: Any local web server (required for ES6 modules)

**Total Code**: ~1,360 lines  
**Dependencies**: 2 (both via CDN)  
**Build Tools**: None  
**Setup**: Start local server, open browser

## License

MIT License - Free to use and modify

## Support

For issues or questions, check the browser console for error messages and verify your CSV format matches the specification above.