# Price Oscillation Analysis

Analyzes trade data to identify oscillation patterns and directional price movements.

## Key Definitions

### Oscillation
A complete oscillation occurs at price P when:
1. Price P is observed in a trade
2. A subsequent trade occurs **above** P
3. A subsequent trade occurs **below** P (or vice versa)
4. **Completion time** = when the SECOND crossing happens

**Example**: Trade at 101 → 102 (above) → 100 (below) = Complete oscillation at 101

Each price level is tracked independently. The same trade sequence can create oscillations at multiple price points.

### Direction Point
A trade at price P where:
- Price did **NOT** complete an oscillation within the search window (MAX_SEARCH_WINDOW trades)
- The trade is **NOT** in the exclusion zone (last N trades where N = 95th percentile threshold)
- Indicates price moved predominantly in ONE direction (only above OR only below P) for abnormally long time

**Note**: "Direction" doesn't mean price is trending strongly - it means price didn't return to cross that level within normal timeframes.

### Exclusion Zone
The last N trades of the dataset are excluded from direction point classification (but can still be oscillations) because we don't have enough forward data to determine if they would eventually oscillate. N is dynamically calculated as the 95th percentile of all oscillation times.

## How Calculations Work

### For Each Trade:
1. Record price P, datetime, timestamp
2. Search forward up to MAX_SEARCH_WINDOW trades
3. Find first trade > P and first trade < P
4. If both exist: 
   - Mark as oscillation
   - Record time to complete (in trades and milliseconds)
5. If only one direction or neither:
   - Check if in exclusion zone
   - If not in exclusion zone: mark as direction point

### Global Metrics:
- **Mean/Std Dev**: Calculated from all completed oscillations
- **95th Percentile Threshold**: The oscillation time value where 95% of oscillations complete faster
- **Z-Score per Price**: (price_level_mean - global_mean) / global_std_dev

### Transition Matrix:
Tracks classification changes when **price changes to a different level**:
- Filters out consecutive trades at the same price
- Shows: Given current classification, what % transitions to oscillation vs direction at next price level

## Configuration

Edit these variables in the script:

```python
START_DATE = '2025-06-01'  # Inclusive - this date IS included
END_DATE = '2025-06-02'    # Exclusive - this date is NOT included
DATA_FILE = 'data.csv'
PERCENTILE_THRESHOLD = 95  # Use 95th percentile for threshold
MAX_SEARCH_WINDOW = 20000  # Maximum trades to search forward
```

## Input Data Format

CSV with columns:
- `datetime` - Timestamp with timezone (e.g., 2025-06-01 22:00:00.068958624+00:00)
- `ticker` - Instrument identifier
- `price` - Trade price (already in 0.25 tick increments)
- `size` - Trade size
- `session_end_date` - Session date
- `timestamp` - Nanosecond precision timestamp (integer)

**Important**: All times are in UTC and remain in UTC. No time conversions are performed.

## Outputs

### 1. per_price_metrics.csv
One row per unique price level with columns:
- `price` - Price level
- `occurrence_count` - Total times this price was traded
- `oscillation_count` - Total oscillations completed from this price
- `oscillation_rate` - oscillation_count / occurrence_count
- `mean_osc_time_trades` - Average trades to complete oscillation
- `std_osc_time_trades` - Standard deviation of trade counts
- `mean_osc_time_ms` - Average milliseconds to complete oscillation
- `std_osc_time_ms` - Standard deviation of milliseconds
- `direction_count` - Number of times this price was a direction point
- `z_score_time_trades` - How unusual this price's oscillation time is vs global mean

### 2. direction_points.csv
List of all identified direction points with:
- `datetime` - When the direction point occurred (full precision)
- `price` - Price level

Use this to investigate specific direction points in context.

### 3. Console Summary
Printed to terminal:
- Global statistics (mean, std dev, thresholds)
- Total direction points identified
- Transition matrix showing classification patterns when price changes

## How to Use

1. Place your `data.csv` in the same directory as the script
2. Edit CONFIG section with your desired date range
3. Run: `python priceosc.py`
4. Review console output for summary statistics
5. Analyze CSV outputs for detailed price-level data

## Interpreting Results

### High Oscillation Rate (>80%)
Price level is "sticky" - frequently touched and quickly oscillated

### Low Oscillation Rate (<20%)
Price level acts as support/resistance - less frequent oscillations

### High Z-Score (>2 or <-2)
Price level's oscillation time is statistically unusual:
- Positive: Takes longer than normal to oscillate
- Negative: Oscillates faster than normal

### Transition Matrix
- **High "Direction → Direction" %**: Direction points tend to cluster (potential trending phases)
- **High "Oscillation → Oscillation" %**: Markets oscillate at consecutive price levels (range-bound)

### Direction Point Clustering
If many direction points appear in sequence at different prices, this suggests a directional move where price is not revisiting recent levels.

## Performance Notes

With MAX_SEARCH_WINDOW = 20,000:
- ~300k trades takes approximately 10-20 minutes
- Progress updates print every 10,000 trades
- Larger windows increase processing time linearly

## Limitations

- Direction points near data end may be misclassified if true oscillation would occur beyond dataset
- MAX_SEARCH_WINDOW caps detection - true direction points could exist beyond this window
- Very illiquid prices (few occurrences) have less statistical significance