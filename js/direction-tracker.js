// Direction Point Tracker - Identifies price levels that don't oscillate within 1K trade windows
class DirectionTracker {
    constructor() {
        this.directionPoints = new Map(); // price -> direction point data
        this.formingCandidates = []; // Array of occurrences tracking toward 1K threshold
        this.currentDate = null;
        this.currentTradeIndex = 0;
        this.THRESHOLD = 20000; // 1K trades to become direction point
    }

    /**
     * Initialize from historical trades (called once at load time)
     * Processes all trades from start of UTC day up to load time
     */
    initializeFromHistory(trades) {
        this.reset();
        
        if (trades.length === 0) return;
        
        // Set current date from first trade
        this.currentDate = new Date(trades[0].time).toISOString().split('T')[0];
        
        console.log(`Initializing direction tracker with ${trades.length} historical trades...`);
        
        // Process each historical trade
        for (let i = 0; i < trades.length; i++) {
            const trade = trades[i];
            this.currentTradeIndex = i;
            
            // Update all forming candidates based on current trade
            this.updateFormingCandidates(trade.price, i);
            
            // Add current trade as new forming candidate
            this.formingCandidates.push({
                tradeIndex: i,
                price: trade.price,
                time: trade.time,
                seenAbove: false,
                seenBelow: false,
                lastCrossIndex: i, // Track last time crossed opposite direction
                lastCrossDirection: null // null, '+', or '-'
            });
        }
        
        // After processing all history, finalize categorization
        this.finalizeHistoricalProcessing();
        
        console.log(`✓ Initialized: ${this.directionPoints.size} direction points, ${this.formingCandidates.length} forming candidates`);
    }

    /**
     * Update forming candidates and check for oscillations/promotions
     */
    updateFormingCandidates(currentPrice, currentIndex) {
        this.formingCandidates = this.formingCandidates.filter(candidate => {
            // Skip if same price as current
            if (candidate.price === currentPrice) {
                return true;
            }
            
            // Track crossings
            const crossedAbove = currentPrice > candidate.price;
            const crossedBelow = currentPrice < candidate.price;
            
            if (crossedAbove && !candidate.seenAbove) {
                candidate.seenAbove = true;
                candidate.lastCrossIndex = currentIndex;
                candidate.lastCrossDirection = '+';
            }
            
            if (crossedBelow && !candidate.seenBelow) {
                candidate.seenBelow = true;
                candidate.lastCrossIndex = currentIndex;
                candidate.lastCrossDirection = '-';
            }
            
            // Check for oscillation within 1K window from last cross
            if (candidate.seenAbove || candidate.seenBelow) {
                const tradesSinceLastCross = currentIndex - candidate.lastCrossIndex;
                
                // Within 1K window - check if oscillated
                if (tradesSinceLastCross <= this.THRESHOLD) {
                    if (candidate.seenAbove && candidate.seenBelow) {
                        // Oscillated within window - remove from tracking
                        return false;
                    }
                }
            }
            
            // Check if ready to promote to direction point
            const tradesSinceOriginal = currentIndex - candidate.tradeIndex;
            if (tradesSinceOriginal >= this.THRESHOLD) {
                // Determine direction
                let direction = null;
                if (candidate.seenAbove && !candidate.seenBelow) {
                    direction = '+';
                } else if (candidate.seenBelow && !candidate.seenAbove) {
                    direction = '-';
                }
                
                if (direction !== null) {
                    // Promote to direction point (keep only most recent per price)
                    const existing = this.directionPoints.get(candidate.price);
                    if (!existing || candidate.tradeIndex > existing.tradeIndex) {
                        this.directionPoints.set(candidate.price, {
                            tradeIndex: candidate.tradeIndex,
                            price: candidate.price,
                            time: candidate.time,
                            direction: direction,
                            seenAbove: candidate.seenAbove,
                            seenBelow: candidate.seenBelow,
                            lastCrossIndex: candidate.lastCrossIndex,
                            lastCrossDirection: candidate.lastCrossDirection
                        });
                    }
                    // Remove from forming candidates
                    return false;
                }
            }
            
            // Keep tracking this candidate
            return true;
        });
    }

    /**
     * After historical processing, promote qualified candidates to direction points
     */
    finalizeHistoricalProcessing() {
        // Process any remaining candidates that qualified during history
        for (const candidate of this.formingCandidates) {
            const tradesSinceOriginal = this.currentTradeIndex - candidate.tradeIndex;
            
            if (tradesSinceOriginal >= this.THRESHOLD) {
                let direction = null;
                if (candidate.seenAbove && !candidate.seenBelow) {
                    direction = '+';
                } else if (candidate.seenBelow && !candidate.seenAbove) {
                    direction = '-';
                }
                
                if (direction !== null) {
                    const existing = this.directionPoints.get(candidate.price);
                    if (!existing || candidate.tradeIndex > existing.tradeIndex) {
                        this.directionPoints.set(candidate.price, {
                            tradeIndex: candidate.tradeIndex,
                            price: candidate.price,
                            time: candidate.time,
                            direction: direction,
                            seenAbove: candidate.seenAbove,
                            seenBelow: candidate.seenBelow,
                            lastCrossIndex: candidate.lastCrossIndex,
                            lastCrossDirection: candidate.lastCrossDirection
                        });
                    }
                }
            }
        }
        
        // Keep only candidates that haven't qualified yet
        this.formingCandidates = this.formingCandidates.filter(candidate => {
            const tradesSinceOriginal = this.currentTradeIndex - candidate.tradeIndex;
            return tradesSinceOriginal < this.THRESHOLD;
        });
    }

    /**
     * Process a single tick during playback (called every tick)
     */
    processTick(trade, tradeIndex, tradeTime) {
        const tradeDate = new Date(tradeTime).toISOString().split('T')[0];
        
        // Reset if date changed
        if (this.currentDate !== tradeDate) {
            console.log(`Date changed from ${this.currentDate} to ${tradeDate}, resetting direction points`);
            this.reset();
            this.currentDate = tradeDate;
        }
        
        this.currentTradeIndex = tradeIndex;
        const currentPrice = trade.price;
        
        // Update direction points - check for oscillations in rolling 1K windows
        for (const [price, dp] of this.directionPoints) {
            if (price === currentPrice) {
                continue; // Price revisit doesn't affect direction point status
            }
            
            const crossedAbove = currentPrice > price;
            const crossedBelow = currentPrice < price;
            
            // Check if this completes an oscillation within 1K window
            if (crossedAbove && dp.lastCrossDirection === '-') {
                // Was below, now crossing above - check if within 1K trades from last cross
                const tradesSinceLastCross = tradeIndex - dp.lastCrossIndex;
                if (tradesSinceLastCross <= this.THRESHOLD) {
                    // Oscillation detected within rolling window - REMOVE
                    this.directionPoints.delete(price);
                    continue;
                }
                // Outside window - update to new crossing direction
                dp.seenAbove = true;
                dp.lastCrossIndex = tradeIndex;
                dp.lastCrossDirection = '+';
            } else if (crossedBelow && dp.lastCrossDirection === '+') {
                // Was above, now crossing below - check if within 1K trades from last cross
                const tradesSinceLastCross = tradeIndex - dp.lastCrossIndex;
                if (tradesSinceLastCross <= this.THRESHOLD) {
                    // Oscillation detected within rolling window - REMOVE
                    this.directionPoints.delete(price);
                    continue;
                }
                // Outside window - update to new crossing direction
                dp.seenBelow = true;
                dp.lastCrossIndex = tradeIndex;
                dp.lastCrossDirection = '-';
            } else if (dp.lastCrossDirection === null) {
                // First time crossing from original price (initial direction establishment)
                if (crossedAbove) {
                    dp.seenAbove = true;
                    dp.lastCrossIndex = tradeIndex;
                    dp.lastCrossDirection = '+';
                } else if (crossedBelow) {
                    dp.seenBelow = true;
                    dp.lastCrossIndex = tradeIndex;
                    dp.lastCrossDirection = '-';
                }
            }
            
            // Update trades since original (for display purposes)
            dp.tradesSince = tradeIndex - dp.tradeIndex;
        }
        
        // Update forming candidates
        this.updateFormingCandidates(currentPrice, tradeIndex);
        
        // Add current trade to forming candidates
        this.formingCandidates.push({
            tradeIndex: tradeIndex,
            price: currentPrice,
            time: tradeTime,
            seenAbove: false,
            seenBelow: false,
            lastCrossIndex: tradeIndex,
            lastCrossDirection: null
        });
    }

    /**
     * Get current direction points for display
     */
    getDirectionPoints() {
        return Array.from(this.directionPoints.values()).map(dp => ({
            price: dp.price,
            direction: dp.direction,
            tradesSince: dp.tradesSince || (this.currentTradeIndex - dp.tradeIndex)
        }));
    }

    /**
     * Reset all tracking (called on date change or manual reset)
     */
    reset() {
        this.directionPoints.clear();
        this.formingCandidates = [];
        this.currentTradeIndex = 0;
    }
}

export default DirectionTracker;