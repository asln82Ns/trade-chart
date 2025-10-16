import pandas as pd
import numpy as np

# ============ CONFIG ============
START_DATE = '2025-06-02'  # Inclusive - this date IS included
END_DATE = '2025-06-03'    # Exclusive - this date is NOT included
DATA_FILE = 'data.csv'
PERCENTILE_THRESHOLD = 95
MAX_SEARCH_WINDOW = 20000  # Maximum trades to search forward for oscillation
# ================================

def determine_direction(start_idx, price, prices, max_window):
    """
    Determine direction (+ or -) of price movement from start_idx.
    + means price only moved above
    - means price only moved below
    """
    search_end = min(start_idx + 1 + max_window, len(prices))
    found_above = False
    found_below = False
    
    for j in range(start_idx + 1, search_end):
        if prices[j] > price:
            found_above = True
        if prices[j] < price:
            found_below = True
        if found_above and found_below:
            break
    
    if found_above and not found_below:
        return "+"
    elif found_below and not found_above:
        return "-"
    else:
        return "mixed"

def analyze_revisit(direction_point_idx, price, prices, timestamps, datetimes, 
                    confirmation_window, max_window):
    """
    Analyze what happens when a direction point price is revisited.
    Only looks AFTER the confirmation window to avoid forward-looking bias.
    """
    confirmation_idx = direction_point_idx + confirmation_window
    n_trades = len(prices)
    
    # Search for revisit after confirmation window
    revisit_idx = None
    for j in range(confirmation_idx + 1, n_trades):
        if prices[j] == price:
            revisit_idx = j
            break
    
    if revisit_idx is None:
        # Never revisited after confirmation
        return {
            'revisited': False,
            'revisit_datetime': None,
            'revisit_result': None,
            'revisit_direction': None,
            'revisit_time_trades': None,
            'revisit_time_ms': None
        }
    
    # Price was revisited - analyze what happens from this point
    revisit_datetime = datetimes[revisit_idx]
    
    # Check for oscillation from revisit point
    above_idx = None
    below_idx = None
    search_end = min(revisit_idx + max_window, n_trades)
    
    for j in range(revisit_idx + 1, search_end):
        if prices[j] > price and above_idx is None:
            above_idx = j
        if prices[j] < price and below_idx is None:
            below_idx = j
        if above_idx is not None and below_idx is not None:
            break
    
    # Determine result
    if above_idx is not None and below_idx is not None:
        # Oscillated after revisit
        completion_idx = max(above_idx, below_idx)
        result = 'oscillation'
        direction = 'N/A'
        time_trades = completion_idx - revisit_idx
        time_ms = (timestamps[completion_idx] - timestamps[revisit_idx]) / 1_000_000.0
    else:
        # Became direction point again
        result = 'direction'
        if above_idx is not None and below_idx is None:
            direction = '+'
        elif below_idx is not None and above_idx is None:
            direction = '-'
        else:
            direction = 'none'  # Hit end of data
        
        # Time = full search window or to end of data
        time_trades = min(max_window, n_trades - revisit_idx - 1)
        end_idx = min(revisit_idx + time_trades, n_trades - 1)
        time_ms = (timestamps[end_idx] - timestamps[revisit_idx]) / 1_000_000.0
    
    return {
        'revisited': True,
        'revisit_datetime': revisit_datetime,
        'revisit_result': result,
        'revisit_direction': direction,
        'revisit_time_trades': int(time_trades),
        'revisit_time_ms': time_ms
    }

def main():
    # Load data
    print("Loading data...")
    df = pd.read_csv(DATA_FILE)
    df['datetime'] = pd.to_datetime(df['datetime'], utc=True)
    
    # Filter by date range (start inclusive, end exclusive)
    df = df[(df['datetime'] >= START_DATE) & (df['datetime'] < END_DATE)].reset_index(drop=True)
    
    if len(df) == 0:
        print(f"ERROR: No data found between {START_DATE} and {END_DATE}")
        return
    
    print(f"Loaded {len(df)} trades between {START_DATE} (inclusive) and {END_DATE} (exclusive)")
    print("Calculating oscillations...\n")
    
    # Convert to numpy arrays for speed (100x faster than pandas .loc)
    prices = df['price'].values
    datetimes = df['datetime'].values
    timestamps = df['timestamp'].values
    n_trades = len(prices)
    
    # Calculate oscillation for each trade
    trade_data = []
    
    for i in range(n_trades):
        price_i = prices[i]
        datetime_i = datetimes[i]
        timestamp_i = timestamps[i]
        
        # Search forward for price movements above and below
        above_idx = None
        below_idx = None
        
        # Limit search to configured window
        search_end = min(i + MAX_SEARCH_WINDOW, n_trades)
        
        for j in range(i + 1, search_end):
            price_j = prices[j]
            
            # Find first trade above price_i
            if price_j > price_i and above_idx is None:
                above_idx = j
            
            # Find first trade below price_i
            if price_j < price_i and below_idx is None:
                below_idx = j
            
            # Stop searching if both crossings found
            if above_idx is not None and below_idx is not None:
                break
        
        # Determine if oscillation completed
        if above_idx is not None and below_idx is not None:
            # Oscillation completes when BOTH sides are crossed
            completion_idx = max(above_idx, below_idx)
            osc_time_trades = completion_idx - i
            osc_time_ms = (timestamps[completion_idx] - timestamp_i) / 1_000_000.0
            
            trade_data.append({
                'index': i,
                'datetime': datetime_i,
                'price': price_i,
                'oscillated': True,
                'osc_time_trades': osc_time_trades,
                'osc_time_ms': osc_time_ms
            })
        else:
            # No complete oscillation found
            trade_data.append({
                'index': i,
                'datetime': datetime_i,
                'price': price_i,
                'oscillated': False,
                'osc_time_trades': np.nan,
                'osc_time_ms': np.nan
            })
        
        # Progress indicator every 10,000 trades
        if (i + 1) % 10000 == 0:
            print(f"  Processed {i + 1:,} / {n_trades:,} trades ({(i+1)/n_trades*100:.1f}%)")
    
    trade_df = pd.DataFrame(trade_data)
    
    # Calculate global metrics from completed oscillations only
    oscillated_df = trade_df[trade_df['oscillated']].copy()
    
    if len(oscillated_df) == 0:
        print("ERROR: No oscillations found in data. Cannot calculate thresholds.")
        return
    
    global_mean_trades = oscillated_df['osc_time_trades'].mean()
    global_std_trades = oscillated_df['osc_time_trades'].std()
    global_mean_ms = oscillated_df['osc_time_ms'].mean()
    global_std_ms = oscillated_df['osc_time_ms'].std()
    
    # Calculate percentile threshold
    threshold_trades = np.percentile(oscillated_df['osc_time_trades'], PERCENTILE_THRESHOLD)
    threshold_ms = np.percentile(oscillated_df['osc_time_ms'], PERCENTILE_THRESHOLD)
    
    # Determine exclusion zone at end of data
    # Last N trades excluded where N = threshold (rounded up)
    exclusion_start_idx = len(df) - int(np.ceil(threshold_trades))
    if exclusion_start_idx < 0:
        exclusion_start_idx = 0
    
    # Classify each trade
    trade_df['classification'] = 'incomplete'
    
    # Trades that oscillated
    trade_df.loc[trade_df['oscillated'], 'classification'] = 'oscillation'
    
    # Trades that didn't oscillate AND are before exclusion zone = direction points
    direction_mask = (~trade_df['oscillated']) & (trade_df['index'] < exclusion_start_idx)
    trade_df.loc[direction_mask, 'classification'] = 'direction_point'
    
    # Aggregate metrics by price level
    price_list = []
    
    for price, group in trade_df.groupby('price'):
        occurrence_count = len(group)
        oscillation_count = group['oscillated'].sum()
        oscillation_rate = oscillation_count / occurrence_count
        
        # Only calculate stats for prices that oscillated at least once
        oscillated_group = group[group['oscillated']]
        if len(oscillated_group) > 0:
            mean_osc_time_trades = oscillated_group['osc_time_trades'].mean()
            std_osc_time_trades = oscillated_group['osc_time_trades'].std()
            mean_osc_time_ms = oscillated_group['osc_time_ms'].mean()
            std_osc_time_ms = oscillated_group['osc_time_ms'].std()
            z_score = (mean_osc_time_trades - global_mean_trades) / global_std_trades
        else:
            mean_osc_time_trades = np.nan
            std_osc_time_trades = np.nan
            mean_osc_time_ms = np.nan
            std_osc_time_ms = np.nan
            z_score = np.nan
        
        direction_count = (group['classification'] == 'direction_point').sum()
        
        price_list.append({
            'price': price,
            'occurrence_count': occurrence_count,
            'oscillation_count': int(oscillation_count),
            'oscillation_rate': oscillation_rate,
            'mean_osc_time_trades': mean_osc_time_trades,
            'std_osc_time_trades': std_osc_time_trades,
            'mean_osc_time_ms': mean_osc_time_ms,
            'std_osc_time_ms': std_osc_time_ms,
            'direction_count': int(direction_count),
            'z_score_time_trades': z_score
        })
    
    price_metrics = pd.DataFrame(price_list)
    price_metrics = price_metrics.sort_values('price').reset_index(drop=True)
    
    # Save per-price metrics
    price_metrics.to_csv('per_price_metrics.csv', index=False)
    print("✓ Saved per_price_metrics.csv")
    
    # Save direction points with revisit analysis
    print("Analyzing direction point revisits...")
    direction_points_list = []
    direction_trades = trade_df[trade_df['classification'] == 'direction_point']
    confirmation_window = int(np.ceil(threshold_trades))
    
    for _, row in direction_trades.iterrows():
        i = row['index']
        price = row['price']
        datetime = row['datetime']
        
        # Determine original direction of this direction point
        original_direction = determine_direction(i, price, prices, MAX_SEARCH_WINDOW)
        
        # Analyze if and how it was revisited (after confirmation window)
        revisit_info = analyze_revisit(
            i, price, prices, timestamps, datetimes,
            confirmation_window, MAX_SEARCH_WINDOW
        )
        
        direction_points_list.append({
            'datetime': pd.Timestamp(datetime).strftime('%Y-%m-%d %H:%M:%S.%f%z'),
            'price': price,
            'original_direction': original_direction,
            'revisited': revisit_info['revisited'],
            'revisit_datetime': pd.Timestamp(revisit_info['revisit_datetime']).strftime('%Y-%m-%d %H:%M:%S.%f%z') if revisit_info['revisit_datetime'] is not None else None,
            'revisit_result': revisit_info['revisit_result'],
            'revisit_direction': revisit_info['revisit_direction'],
            'revisit_time_trades': revisit_info['revisit_time_trades'],
            'revisit_time_ms': revisit_info['revisit_time_ms']
        })
    
    direction_points = pd.DataFrame(direction_points_list)
    direction_points.to_csv('direction_points.csv', index=False)
    print("✓ Saved direction_points.csv")
    
    # Calculate transition matrix (only when price changes)
    classified_trades = trade_df[trade_df['classification'].isin(['oscillation', 'direction_point'])].copy()
    classified_trades = classified_trades.reset_index(drop=True)
    
    transitions = {
        'osc_to_osc': 0,
        'osc_to_dir': 0,
        'dir_to_osc': 0,
        'dir_to_dir': 0
    }
    
    if len(classified_trades) > 1:
        for i in range(len(classified_trades) - 1):
            current_class = classified_trades.loc[i, 'classification']
            current_price = classified_trades.loc[i, 'price']
            
            # Find next trade with DIFFERENT price
            next_idx = None
            for j in range(i + 1, len(classified_trades)):
                if classified_trades.loc[j, 'price'] != current_price:
                    next_idx = j
                    break
            
            if next_idx is not None:
                next_class = classified_trades.loc[next_idx, 'classification']
                
                if current_class == 'oscillation':
                    if next_class == 'oscillation':
                        transitions['osc_to_osc'] += 1
                    else:
                        transitions['osc_to_dir'] += 1
                else:  # current == 'direction_point'
                    if next_class == 'oscillation':
                        transitions['dir_to_osc'] += 1
                    else:
                        transitions['dir_to_dir'] += 1
    
    # Calculate percentages for transition matrix
    osc_total = transitions['osc_to_osc'] + transitions['osc_to_dir']
    dir_total = transitions['dir_to_osc'] + transitions['dir_to_dir']
    
    osc_to_osc_pct = (transitions['osc_to_osc'] / osc_total * 100) if osc_total > 0 else 0
    osc_to_dir_pct = (transitions['osc_to_dir'] / osc_total * 100) if osc_total > 0 else 0
    dir_to_osc_pct = (transitions['dir_to_osc'] / dir_total * 100) if dir_total > 0 else 0
    dir_to_dir_pct = (transitions['dir_to_dir'] / dir_total * 100) if dir_total > 0 else 0
    
    # Print console summary
    print("\n" + "="*70)
    print("GLOBAL METRICS")
    print("="*70)
    print(f"Total unique prices: {len(price_metrics)}")
    print(f"Total trades analyzed: {len(df)}")
    print(f"Trades excluded (end): {len(df) - exclusion_start_idx}")
    print(f"Overall mean oscillation time: {global_mean_trades:.1f} trades / {global_mean_ms:.1f}ms")
    print(f"Overall std dev: {global_std_trades:.1f} trades / {global_std_ms:.1f}ms")
    print(f"{PERCENTILE_THRESHOLD}th percentile threshold: {threshold_trades:.0f} trades / {threshold_ms:.0f}ms")
    
    print("\n" + "="*70)
    print("DIRECTION POINT ANALYSIS")
    print("="*70)
    print("Definition: A trade where price did NOT oscillate (cross both above")
    print(f"and below) within {MAX_SEARCH_WINDOW} trades and is not in exclusion zone.\n")
    total_direction_points = len(direction_points)
    direction_pct = (total_direction_points / len(df) * 100)
    print(f"Total direction points identified: {total_direction_points} ({direction_pct:.2f}% of all trades)")
    
    # Revisit statistics
    revisited_count = direction_points['revisited'].sum()
    if total_direction_points > 0:
        revisit_rate = (revisited_count / total_direction_points * 100)
        print(f"Direction points revisited: {revisited_count} ({revisit_rate:.1f}%)")
        
        if revisited_count > 0:
            revisited_df = direction_points[direction_points['revisited']]
            
            # Count outcomes
            osc_count = (revisited_df['revisit_result'] == 'oscillation').sum()
            dir_count = (revisited_df['revisit_result'] == 'direction').sum()
            
            print(f"\nRevisit Outcomes:")
            print(f"  Oscillated: {osc_count} ({osc_count/revisited_count*100:.1f}%)")
            print(f"  Direction: {dir_count} ({dir_count/revisited_count*100:.1f}%)")
            
            # Direction analysis
            if dir_count > 0:
                dir_revisited = revisited_df[revisited_df['revisit_result'] == 'direction']
                same_dir = (dir_revisited['original_direction'] == dir_revisited['revisit_direction']).sum()
                opp_dir = ((dir_revisited['original_direction'] == '+') & (dir_revisited['revisit_direction'] == '-')).sum() + \
                         ((dir_revisited['original_direction'] == '-') & (dir_revisited['revisit_direction'] == '+')).sum()
                
                print(f"\n  Of Direction Points:")
                print(f"    Same direction: {same_dir} ({same_dir/dir_count*100:.1f}%)")
                print(f"    Opposite direction: {opp_dir} ({opp_dir/dir_count*100:.1f}%)")
            
            # Oscillation timing
            if osc_count > 0:
                osc_times = revisited_df[revisited_df['revisit_result'] == 'oscillation']['revisit_time_trades']
                print(f"\n  Oscillation times (when failed):")
                print(f"    Mean: {osc_times.mean():.1f} trades / {revisited_df[revisited_df['revisit_result'] == 'oscillation']['revisit_time_ms'].mean():.1f}ms")
                print(f"    Median: {osc_times.median():.1f} trades")
    
    if len(classified_trades) > 1:
        print("\n" + "="*70)
        print("TRANSITION MATRIX (Price Changes Only)")
        print("="*70)
        print("Shows classification transitions when price changes to different level.\n")
        print(f"                    {'Following Event':^48}")
        print(f"                    {'Oscillation':^24}{'Direction':^24}")
        print("-"*70)
        print(f"After Oscillation   {osc_to_osc_pct:^22.1f}%  {osc_to_dir_pct:^22.1f}%")
        print(f"After Direction     {dir_to_osc_pct:^22.1f}%  {dir_to_dir_pct:^22.1f}%")
        print("="*70)
    
    print("\n✓ Analysis complete!")

if __name__ == "__main__":
    main()