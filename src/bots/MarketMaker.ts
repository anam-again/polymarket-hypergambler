import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";
import { ScalingPEQ } from "../utils/ScalingPEQ.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface MarketMakerProps extends QuantBotProps {
    // Spread configuration
    spreadSize: number;           // Number of price levels to buy (e.g., 5 = buy at 49, 48, 47, 46, 45 when market is 50)
    minSpreadDistance: number;    // Distance from market price to start spread (e.g., 0.03 = first order 3 cents below market)
    profitMargin: number;         // Cents above buy price to sell (e.g., 0.10 = sell at buyPrice + 0.10)

    // Price bounds
    minPrice: number;             // Never buy tokens priced below this (e.g., 0.40)
    maxPrice: number;             // Never buy tokens priced above this (e.g., 0.60)

    // Risk management
    stopLossAmount: number;       // Sell if price drops this much below entry (e.g., 0.10 = 10 cents)
    buyExpirySeconds?: number;    // Cancel and recycle live buy orders older than this (e.g., 60 = 1 minute)

    // Position limits
    totalActiveTrades: number;    // Max concurrent positions (live buys + matched buys without sells)

    // Volatility filter
    maxVolatility: number;        // Maximum volatility scalar to enter trades (skip if exceeded)
    minVolatility: number;        // Minimum volatility scalar to enter trades (skip if below)
    volatilityLookbackPeriods: number;  // Periods to measure volatility

    // Standard parameters
    targetDollars: number;        // Dollar amount per position
    cutoffMinute: number;         // Stop new trades after this minute

    // Timeout configuration with polynomial scaling
    sellTimeout: number;                      // Base timeout (seconds) before canceling unfilled sell order
    sellTimeoutPEQ: ScalingPEQ;               // Polynomial scaling for sellTimeout based on time left
    stoplossCheckTimeout: number;             // Base delay (seconds) before posting stoploss after buy match
    stoplossCheckTimeoutPEQ: ScalingPEQ;      // Polynomial scaling for stoplossCheckTimeout based on time left
    stoplossFailureTimeout: number;           // Seconds before re-adjusting unfilled stoploss order
    stoplossFailureTimeoutPEQ: ScalingPEQ;    // Polynomial scaling for stoplossFailureTimeout based on time left
}

interface ActivePosition {
    buyOrder: TradeOrder;
    sellOrder?: TradeOrder;
    entryPrice: number;
    spreadOffset: number;         // How many cents below market at entry
    tokenDirection: 'UP' | 'DOWN';
    stopLossPrice: number;
    stopLossTriggered?: boolean;  // Track if we need emergency exit (for retry logic)
    buyExpired?: boolean;         // Track if buy was expired and needs retry
    tokensSold: number;           // Track how many tokens have been sold (to prevent overselling)
    sellOrderHistory: string[];   // Track all sell order IDs created for this position
    buyMatchedAt?: number;        // Timestamp when buy was matched
    sellOrderCreatedAt?: number;  // Timestamp when sell order was created
    stoplossCreatedAt?: number;   // Timestamp when stoploss order was created
}

type TokenDirection = 'UP' | 'DOWN';

// ============================================================================
// MarketMaker Class
// ============================================================================

export class MarketMaker extends QuantBot implements QuantBotRun {

    // --- Configuration ---
    private readonly MIN_ORDER_SIZE = 5;
    private readonly MIN_ORDER_VALUE = 1.00;
    private readonly MAX_SELL_PRICE = 0.95;
    private readonly SPREAD_STEP = 0.01;  // 1 cent per level

    // --- Properties ---
    private spreadSize: number;
    private minSpreadDistance: number;
    private profitMargin: number;
    private minPrice: number;
    private maxPrice: number;
    private stopLossAmount: number;
    private buyExpirySeconds: number | null;
    private totalActiveTrades: number;
    private maxVolatility: number;
    private minVolatility: number;
    private volatilityLookbackPeriods: number;
    private targetDollars: number;
    private cutoffMinute: number;

    // --- Timeout Properties ---
    private sellTimeout: number;
    private sellTimeoutPEQ: ScalingPEQ;
    private stoplossCheckTimeout: number;
    private stoplossCheckTimeoutPEQ: ScalingPEQ;
    private stoplossFailureTimeout: number;
    private stoplossFailureTimeoutPEQ: ScalingPEQ;

    // --- Position Tracking ---
    private upPositions: Map<string, ActivePosition> = new Map();
    private downPositions: Map<string, ActivePosition> = new Map();

    // --- State ---
    private isPastCutoff: boolean = false;

    // --- Constructor ---

    constructor(props: MarketMakerProps) {
        super(props);

        this.spreadSize = props.spreadSize;
        this.minSpreadDistance = props.minSpreadDistance;
        this.profitMargin = props.profitMargin;
        this.minPrice = props.minPrice;
        this.maxPrice = props.maxPrice;
        this.stopLossAmount = props.stopLossAmount;
        this.buyExpirySeconds = props.buyExpirySeconds ?? null;
        this.totalActiveTrades = props.totalActiveTrades;
        this.maxVolatility = props.maxVolatility;
        this.minVolatility = props.minVolatility;
        this.volatilityLookbackPeriods = props.volatilityLookbackPeriods;
        this.targetDollars = props.targetDollars;
        this.cutoffMinute = props.cutoffMinute;

        // Timeout configuration with polynomial scaling
        this.sellTimeout = props.sellTimeout ?? 30;
        this.sellTimeoutPEQ = props.sellTimeoutPEQ;
        this.stoplossCheckTimeout = props.stoplossCheckTimeout ?? 10;
        this.stoplossCheckTimeoutPEQ = props.stoplossCheckTimeoutPEQ;
        this.stoplossFailureTimeout = props.stoplossFailureTimeout ?? 15;
        this.stoplossFailureTimeoutPEQ = props.stoplossFailureTimeoutPEQ;
    }

    // --- Main Run Loop ---

    public async run(): Promise<void> {
        this.setupPeriodReset();
        this.startTradingLoop();
    }

    // -------------------------------------------------------------------------
    // Timeout Calculation Helpers
    // -------------------------------------------------------------------------

    /**
     * Calculates a scaled timeout based on time remaining in the trading period.
     * Uses polynomial equation scaling for more expressive optimization.
     *
     * @param baseTimeout - Base timeout in seconds
     * @param peq - ScalingPEQ for polynomial-based scaling
     * @returns Scaled timeout in milliseconds
     */
    private calculateScaledTimeout(baseTimeout: number, peq: ScalingPEQ): number {
        // Calculate time remaining in period (0-1, where 1 = full period remaining)
        const minuteInPeriod = this.getMinutesIntoPeriod();
        const periodLength = this.marketSchedule === MarketSchedule.QUARTERLY ? 15 : 60;
        const timeRemaining = (periodLength - minuteInPeriod) / periodLength;

        // Use polynomial scaling: baseTimeout * f(timeRemaining)
        const scaledTimeout = peq.scale(baseTimeout, timeRemaining);
        return Math.max(5000, scaledTimeout * 1000); // Minimum 5 seconds, convert to ms
    }

    /**
     * Gets the current minute within the trading period.
     * For quarterly markets (15-min periods), returns 0-14.
     * For hourly markets (60-min periods), returns 0-59.
     */
    private getMinutesIntoPeriod(): number {
        const currentMinute = this.clock.getMinutes();
        return this.marketSchedule === MarketSchedule.QUARTERLY
            ? currentMinute % 15
            : currentMinute;
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    private setupPeriodReset(): void {
        this.registerResetHandler(async () => {
            await this.updateOrders();
            await this.auditAndReset();
            this.resetTradeState();
        });
    }

    protected override resetTradeState(): void {
        this.upPositions.clear();
        this.downPositions.clear();
        this.isPastCutoff = false;
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 5, 1000 * 2, async () => {
            await this.executeTradingLogic();
        });
    }

    private async executeTradingLogic(): Promise<void> {
        // 1. Update all order statuses
        await this.updateOrders();

        // 2. Sync positions with updated orders
        this.syncPositionsWithOrders();

        // 3. Check for expired buy orders (cancel and mark for retry)
        await this.checkExpiredBuyOrders();

        // 4. Retry expired buy orders
        await this.retryExpiredBuyOrders();

        // 5. Check stop-losses for all matched positions
        await this.checkAllStopLosses();

        // 6. Check for stop-loss recovery (price recovered above entry)
        await this.checkStopLossRecovery();

        // 6.5 Check for sell order timeouts and reprice if needed
        await this.checkSellOrderTimeouts();

        // 7. Create sell orders for newly matched buys
        await this.createSellOrdersForMatchedBuys();

        // 8. Check for completed sells (trade recycling)
        await this.handleCompletedSells();

        // 9. Check cutoff and volatility before placing new orders
        if (this.isAfterCutoff()) {
            if (!this.isPastCutoff) {
                this.isPastCutoff = true;
                await this.cancelAllLiveBuyOrders();
            }
            return;
        }

        // 10. Check volatility filter
        const volatility = await this.calculateVolatility();
        if (volatility < this.minVolatility) {
            this.writeLog(`Volatility ${volatility.toFixed(2)} < min ${this.minVolatility}, skipping new orders`);
            return;
        }
        if (volatility > this.maxVolatility) {
            this.writeLog(`Volatility ${volatility.toFixed(2)} > max ${this.maxVolatility}, skipping new orders`);
            return;
        }

        // 11. Count active trades and refresh spread if under limit
        const activeCount = this.countActiveTrades();
        if (activeCount < this.totalActiveTrades) {
            await this.refreshSpreadOrders();
        }
    }

    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    // -------------------------------------------------------------------------
    // Position Management
    // -------------------------------------------------------------------------

    private syncPositionsWithOrders(): void {
        // Update position states based on order statuses
        for (const [_, position] of this.upPositions) {
            this.updatePositionFromOrders(position);
        }
        for (const [_, position] of this.downPositions) {
            this.updatePositionFromOrders(position);
        }
    }

    private updatePositionFromOrders(position: ActivePosition): void {
        // Find the actual order objects in trades array to get updated status
        const buyTrade = this.trades.find(t => t.orderId === position.buyOrder.orderId);
        if (buyTrade) {
            position.buyOrder = buyTrade;
        }

        if (position.sellOrder) {
            const sellTrade = this.trades.find(t => t.orderId === position.sellOrder!.orderId);
            if (sellTrade) {
                position.sellOrder = sellTrade;
            }
        }

        // CRITICAL: Check ALL historical sell orders to count total tokens sold
        // This prevents the race condition where we create new sells before old ones are confirmed canceled
        this.syncSoldTokensFromHistory(position);
    }

    /**
     * Syncs the tokensSold count from all historical sell orders.
     * This catches cases where an "old" sell order was matched after we tried to cancel it.
     */
    private syncSoldTokensFromHistory(position: ActivePosition): void {
        let totalSold = 0;

        for (const orderId of position.sellOrderHistory) {
            const trade = this.trades.find(t => t.orderId === orderId);
            if (trade && trade.status === TradeStatus.MATCHED) {
                totalSold += trade.amount;
            }
        }

        // If we've sold more than before, log it (this indicates a race condition occurred)
        if (totalSold > position.tokensSold) {
            const newlySold = totalSold - position.tokensSold;
            this.writeLog(
                `SYNC: ${position.tokenDirection} position offset ${position.spreadOffset} ` +
                `detected ${newlySold} additional tokens sold (total: ${totalSold}/${position.buyOrder.amount})`
            );
            position.tokensSold = totalSold;
        }
    }

    private countActiveTrades(): number {
        let count = 0;

        // Count UP positions: live buys + matched buys without completed sells
        for (const position of this.upPositions.values()) {
            if (position.buyOrder.status === TradeStatus.LIVE) {
                count++;
            } else if (position.buyOrder.status === TradeStatus.MATCHED) {
                if (!position.sellOrder || position.sellOrder.status !== TradeStatus.MATCHED) {
                    count++;
                }
            }
        }

        // Count DOWN positions: live buys + matched buys without completed sells
        for (const position of this.downPositions.values()) {
            if (position.buyOrder.status === TradeStatus.LIVE) {
                count++;
            } else if (position.buyOrder.status === TradeStatus.MATCHED) {
                if (!position.sellOrder || position.sellOrder.status !== TradeStatus.MATCHED) {
                    count++;
                }
            }
        }

        return count;
    }

    private getPositionKey(direction: TokenDirection, spreadOffset: number): string {
        return `${direction}-offset-${spreadOffset}`;
    }

    // -------------------------------------------------------------------------
    // Buy Order Expiry Logic
    // -------------------------------------------------------------------------

    private async checkExpiredBuyOrders(): Promise<void> {
        if (this.buyExpirySeconds === null) return;

        const now = this.clock.now();
        const expiryMs = this.buyExpirySeconds * 1000;

        // Check UP positions
        for (const [_, position] of this.upPositions) {
            if (this.isBuyOrderExpired(position, now, expiryMs)) {
                await this.handleExpiredBuy(position, 'UP');
            }
        }

        // Check DOWN positions
        for (const [_, position] of this.downPositions) {
            if (this.isBuyOrderExpired(position, now, expiryMs)) {
                await this.handleExpiredBuy(position, 'DOWN');
            }
        }
    }

    private isBuyOrderExpired(position: ActivePosition, now: number, expiryMs: number): boolean {
        // Only check live buy orders that haven't already been marked as expired
        if (position.buyOrder.status !== TradeStatus.LIVE) return false;
        if (position.buyExpired) return false;

        const orderAge = now - position.buyOrder.createdAt;
        return orderAge >= expiryMs;
    }

    private async handleExpiredBuy(position: ActivePosition, _direction: TokenDirection): Promise<void> {
        // this.writeLog(
        //     `BUY EXPIRED: ${direction} position at offset ${position.spreadOffset}, ` +
        //     `price=${position.entryPrice.toFixed(2)}, age=${orderAge}s (limit=${this.buyExpirySeconds}s)`
        // );

        // Cancel the expired buy order
        await this.cancelTrade(position.buyOrder);

        // Mark as expired for retry logic
        position.buyExpired = true;
    }

    private async retryExpiredBuyOrders(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        // Retry expired UP buys
        for (const [_, position] of this.upPositions) {
            if (this.positionNeedsBuyOrder(position)) {
                await this.createBuyForPosition(position, orderBooks.BtcUpTokenId, 'UP');
            }
        }

        // Retry expired DOWN buys
        for (const [_, position] of this.downPositions) {
            if (this.positionNeedsBuyOrder(position)) {
                await this.createBuyForPosition(position, orderBooks.BtcDownTokenId, 'DOWN');
            }
        }
    }

    private positionNeedsBuyOrder(position: ActivePosition): boolean {
        // Only retry if buy was expired (not cutoff canceled or other)
        if (!position.buyExpired) return false;

        // No buy order (makeOrder returned undefined)
        if (!position.buyOrder) return true;

        // Buy order was canceled (retry needed)
        if (position.buyOrder.status === TradeStatus.CANCELED) return true;

        return false;
    }

    private async createBuyForPosition(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<void> {
        // Get current ask price to place at current market
        const currentAskPrice = await this.marketInfo.getPrice(tokenId, Side.BUY, this.targetedMarket);

        // Calculate buy price: current price - minSpreadDistance - ((offset - 1) * step)
        const buyPrice = Math.round((currentAskPrice - this.minSpreadDistance - ((position.spreadOffset - 1) * this.SPREAD_STEP)) * 100) / 100;

        // Check price bounds
        if (buyPrice < this.minPrice) {
            // this.writeLog(`Retry ${direction} buy at ${buyPrice.toFixed(2)} below minPrice ${this.minPrice}, skipping`);
            return;
        }
        if (buyPrice > this.maxPrice) {
            // this.writeLog(`Retry ${direction} buy at ${buyPrice.toFixed(2)} above maxPrice ${this.maxPrice}, skipping`);
            return;
        }

        // Check for conflicting sell order at same price
        if (this.hasLiveSellAtPrice(buyPrice, tokenId)) {
            // this.writeLog(`Retry ${direction} buy at ${buyPrice.toFixed(2)} conflicts with existing SELL order, skipping`);
            return;
        }

        // Calculate position size
        const positionSize = this.calculateValidPositionSize(buyPrice);
        if (positionSize === null) {
            // this.writeLog(`Cannot retry ${direction} order: position size calculation failed`);
            return;
        }

        const totalCost = buyPrice * positionSize;
        if (!this.canSpendFromBudget(totalCost)) {
            // this.writeLog(`Cannot retry ${direction} order: would exceed hourly budget`);
            return;
        }

        // Update stop-loss price for new entry price
        const stopLossPrice = Math.max(0.01, buyPrice - this.stopLossAmount);

        const orderName = `mm-buy-retry-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;

        // this.writeLog(
        //     `Retrying ${direction} buy: price=${buyPrice.toFixed(2)}, ` +
        //     `offset=${position.spreadOffset}, size=${positionSize}, ` +
        //     `stop=${stopLossPrice.toFixed(2)}`
        // );

        const buyOrder = await this.makeOrder(
            orderName,
            tokenId,
            buyPrice,
            positionSize,
            Side.BUY
        );

        if (buyOrder) {
            // Update position with new buy order and entry price
            position.buyOrder = buyOrder;
            position.entryPrice = buyPrice;
            position.stopLossPrice = stopLossPrice;
            position.buyExpired = false;  // Reset flag on success
        }
        // If makeOrder returns undefined, position.buyExpired stays true for next retry
    }

    // -------------------------------------------------------------------------
    // Stop-Loss Logic
    // -------------------------------------------------------------------------

    private async checkAllStopLosses(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        // Check UP positions
        for (const [_, position] of this.upPositions) {
            if (position.buyOrder.status === TradeStatus.MATCHED) {
                const triggered = await this.checkPositionStopLoss(
                    position,
                    orderBooks.BtcUpTokenId,
                    'UP'
                );
                if (triggered) {
                    // this.writeLog(`Stop-loss triggered for UP position at offset ${position.spreadOffset}`);
                }
            }
        }

        // Check DOWN positions
        for (const [_, position] of this.downPositions) {
            if (position.buyOrder.status === TradeStatus.MATCHED) {
                const triggered = await this.checkPositionStopLoss(
                    position,
                    orderBooks.BtcDownTokenId,
                    'DOWN'
                );
                if (triggered) {
                    // this.writeLog(`Stop-loss triggered for DOWN position at offset ${position.spreadOffset}`);
                }
            }
        }
    }

    private async checkPositionStopLoss(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<boolean> {
        // Skip if no matched buy or already have a matched sell
        if (position.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (position.sellOrder?.status === TradeStatus.MATCHED) return false;

        // If stop-loss already triggered, don't re-trigger (recovery logic handles updates)
        if (position.stopLossTriggered) return false;

        // CRITICAL: Check if all tokens have already been sold (prevents overselling)
        if (position.tokensSold >= position.buyOrder.amount) {
            this.writeLog(
                `SKIP STOPLOSS: ${direction} offset ${position.spreadOffset} - ` +
                `all ${position.tokensSold} tokens already sold`
            );
            return false;
        }

        // After buy matched, wait stoplossCheckTimeout before checking stoploss
        if (!position.buyMatchedAt) {
            position.buyMatchedAt = this.clock.now();
        }
        const scaledDelay = this.calculateScaledTimeout(
            this.stoplossCheckTimeout,
            this.stoplossCheckTimeoutPEQ
        );
        if (this.clock.now() - position.buyMatchedAt < scaledDelay) {
            return false; // Not yet time to check stoploss
        }

        try {
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

            if (currentBidPrice <= position.stopLossPrice) {
                // Mark as stop-loss triggered (persists for retry)
                position.stopLossTriggered = true;

                // Calculate remaining tokens to sell
                const remainingTokens = position.buyOrder.amount - position.tokensSold;
                if (remainingTokens <= 0) {
                    this.writeLog(
                        `SKIP STOPLOSS: ${direction} offset ${position.spreadOffset} - ` +
                        `no tokens remaining to sell`
                    );
                    return false;
                }

                this.writeLog(
                    `STOP-LOSS: ${direction} position at ${position.entryPrice.toFixed(2)} ` +
                    `triggered at ${currentBidPrice.toFixed(2)} (stop: ${position.stopLossPrice.toFixed(2)}) ` +
                    `tokens: ${remainingTokens}/${position.buyOrder.amount}`
                );

                // Cancel existing regular sell order if any
                if (position.sellOrder && position.sellOrder.status === TradeStatus.LIVE) {
                    await this.cancelTrade(position.sellOrder);
                    // Don't clear sellOrder yet - wait to verify it was actually canceled
                }

                // Only create new sell if no live sell order exists
                if (!position.sellOrder || position.sellOrder.status === TradeStatus.CANCELED) {
                    const emergencySellPrice = Math.max(0.01, currentBidPrice - 0.01);
                    const sellOrderName = `mm-stoploss-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;

                    const newSellOrder = await this.makeOrder(
                        sellOrderName,
                        tokenId,
                        emergencySellPrice,
                        remainingTokens,
                        Side.SELL
                    );

                    if (newSellOrder) {
                        position.sellOrder = newSellOrder;
                        position.sellOrderHistory.push(newSellOrder.orderId);
                        position.stoplossCreatedAt = this.clock.now();
                    }
                }

                return true;
            }
        } catch (error) {
            this.writeError(`Error checking stop-loss for ${direction}: ${error}`);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Stop-Loss Recovery Logic
    // -------------------------------------------------------------------------

    private async checkStopLossRecovery(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        // Check UP positions for stop-loss recovery
        for (const [_, position] of this.upPositions) {
            if (await this.checkPositionStopLossRecovery(position, orderBooks.BtcUpTokenId, 'UP')) {
                this.writeLog(`Stop-loss recovered for UP position at offset ${position.spreadOffset}`);
            }
        }

        // Check DOWN positions for stop-loss recovery
        for (const [_, position] of this.downPositions) {
            if (await this.checkPositionStopLossRecovery(position, orderBooks.BtcDownTokenId, 'DOWN')) {
                this.writeLog(`Stop-loss recovered for DOWN position at offset ${position.spreadOffset}`);
            }
        }
    }

    private async checkPositionStopLossRecovery(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<boolean> {
        // Only check positions with stop-loss triggered
        if (!position.stopLossTriggered) return false;

        // CRITICAL: Check if all tokens have already been sold (prevents overselling)
        if (position.tokensSold >= position.buyOrder.amount) {
            // All tokens sold - nothing to do
            return false;
        }

        const remainingTokens = position.buyOrder.amount - position.tokensSold;

        try {
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

            // Case 1: Price recovered above entry - revert to regular profit sell
            if (currentBidPrice > position.entryPrice) {
                this.writeLog(
                    `STOP-LOSS RECOVERY: ${direction} position at ${position.entryPrice.toFixed(2)} ` +
                    `recovered to ${currentBidPrice.toFixed(2)}, reverting to profit sell ` +
                    `(remaining: ${remainingTokens} tokens)`
                );

                // Cancel the stop-loss sell order if exists and is LIVE
                if (position.sellOrder && position.sellOrder.status === TradeStatus.LIVE) {
                    await this.cancelTrade(position.sellOrder);
                    // Wait for next sync to confirm cancellation before clearing
                }

                // Reset stop-loss state so regular sell will be created
                position.stopLossTriggered = false;

                // Only clear sellOrder if it was actually canceled
                if (position.sellOrder?.status === TradeStatus.CANCELED) {
                    position.sellOrder = undefined;
                }

                return true;
            }

            // Case 2: Price in "danger zone" (above stop-loss but below entry)
            // Update emergency sell price if it's become stale (by price OR timeout)
            if (currentBidPrice > position.stopLossPrice && position.sellOrder?.status === TradeStatus.LIVE) {
                const currentSellPrice = position.sellOrder.targetSellPrice ?? 0;
                const optimalEmergencyPrice = Math.max(0.01, currentBidPrice - 0.01);

                // Check if stoploss order has timed out (not filled within configured time)
                let stoplossTimedOut = false;
                if (position.stoplossCreatedAt) {
                    const scaledTimeout = this.calculateScaledTimeout(
                        this.stoplossFailureTimeout,
                        this.stoplossFailureTimeoutPEQ
                    );
                    stoplossTimedOut = this.clock.now() - position.stoplossCreatedAt > scaledTimeout;
                }

                // If current sell price is more than 2 cents below optimal, OR timeout exceeded, update it
                if (optimalEmergencyPrice - currentSellPrice >= 0.02 || stoplossTimedOut) {
                    this.writeLog(
                        `STOP-LOSS UPDATE: ${direction} position updating emergency sell from ` +
                        `${currentSellPrice.toFixed(2)} to ${optimalEmergencyPrice.toFixed(2)} ` +
                        `(bid=${currentBidPrice.toFixed(2)}, remaining: ${remainingTokens} tokens)`
                    );

                    // Cancel stale emergency sell
                    await this.cancelTrade(position.sellOrder);

                    // CRITICAL: Update orders to check if cancel succeeded or if order was matched
                    await this.updateOrders();
                    this.syncSoldTokensFromHistory(position);

                    // Re-check remaining tokens after sync
                    const updatedRemaining = position.buyOrder.amount - position.tokensSold;
                    if (updatedRemaining <= 0) {
                        this.writeLog(
                            `STOP-LOSS UPDATE ABORTED: ${direction} offset ${position.spreadOffset} - ` +
                            `old order was matched, no tokens remaining`
                        );
                        position.sellOrder = undefined;
                        return true;
                    }

                    // Check if the sell order was actually canceled (not matched)
                    const oldOrder = this.trades.find(t => t.orderId === position.sellOrder?.orderId);
                    if (oldOrder?.status === TradeStatus.MATCHED) {
                        this.writeLog(
                            `STOP-LOSS UPDATE ABORTED: ${direction} offset ${position.spreadOffset} - ` +
                            `old order was matched during cancel attempt`
                        );
                        position.sellOrder = oldOrder;  // Keep reference to matched order
                        return true;
                    }

                    // Old order was successfully canceled, create new one
                    position.sellOrder = undefined;

                    // Create updated emergency sell at current price with remaining tokens
                    const sellOrderName = `mm-stoploss-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;
                    const newSellOrder = await this.makeOrder(
                        sellOrderName,
                        tokenId,
                        optimalEmergencyPrice,
                        updatedRemaining,
                        Side.SELL
                    );

                    if (newSellOrder) {
                        position.sellOrder = newSellOrder;
                        position.sellOrderHistory.push(newSellOrder.orderId);
                        position.stoplossCreatedAt = this.clock.now();
                    }

                    return true;
                }
            }

            // Case 3: No sell order exists (previous attempt failed) - will be retried by createSellOrdersForMatchedBuys
        } catch (error) {
            this.writeError(`Error checking stop-loss recovery for ${direction}: ${error}`);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Sell Order Timeout Logic
    // -------------------------------------------------------------------------

    /**
     * Checks for regular sell orders that have timed out and reprices them.
     * Only applies to non-stoploss sell orders that remain unfilled.
     */
    private async checkSellOrderTimeouts(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        // Check UP positions
        for (const [_, position] of this.upPositions) {
            await this.checkPositionSellTimeout(position, orderBooks.BtcUpTokenId, 'UP');
        }

        // Check DOWN positions
        for (const [_, position] of this.downPositions) {
            await this.checkPositionSellTimeout(position, orderBooks.BtcDownTokenId, 'DOWN');
        }
    }

    private async checkPositionSellTimeout(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<boolean> {
        // Only check positions with:
        // - Matched buy order
        // - Live sell order (non-stoploss)
        // - Sell order timestamp tracked
        if (position.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (!position.sellOrder || position.sellOrder.status !== TradeStatus.LIVE) return false;
        if (position.stopLossTriggered) return false; // Don't reprice stoploss orders here
        if (!position.sellOrderCreatedAt) return false;

        // Check if sell order has timed out
        const scaledTimeout = this.calculateScaledTimeout(
            this.sellTimeout,
            this.sellTimeoutPEQ
        );

        if (this.clock.now() - position.sellOrderCreatedAt <= scaledTimeout) {
            return false; // Not yet timed out
        }

        // CRITICAL: Check if all tokens have already been sold
        if (position.tokensSold >= position.buyOrder.amount) {
            return false;
        }

        const remainingTokens = position.buyOrder.amount - position.tokensSold;

        try {
            // Get current market bid price
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

            // Calculate new sell price: slightly below market bid to encourage fill
            const newSellPrice = Math.min(
                Math.max(0.01, currentBidPrice - 0.01),
                this.MAX_SELL_PRICE
            );

            this.writeLog(
                `SELL TIMEOUT: ${direction} offset ${position.spreadOffset} - ` +
                `repricing from ${position.sellOrder.targetSellPrice?.toFixed(2)} to ${newSellPrice.toFixed(2)} ` +
                `(bid=${currentBidPrice.toFixed(2)}, remaining: ${remainingTokens} tokens)`
            );

            // Cancel the current sell order
            await this.cancelTrade(position.sellOrder);

            // Update orders to check if cancel succeeded or if order was matched
            await this.updateOrders();
            this.syncSoldTokensFromHistory(position);

            // Re-check remaining tokens after sync
            const updatedRemaining = position.buyOrder.amount - position.tokensSold;
            if (updatedRemaining <= 0) {
                this.writeLog(
                    `SELL TIMEOUT ABORTED: ${direction} offset ${position.spreadOffset} - ` +
                    `old order was matched, no tokens remaining`
                );
                position.sellOrder = undefined;
                return true;
            }

            // Check if the sell order was actually canceled (not matched)
            const oldOrder = this.trades.find(t => t.orderId === position.sellOrder?.orderId);
            if (oldOrder?.status === TradeStatus.MATCHED) {
                this.writeLog(
                    `SELL TIMEOUT ABORTED: ${direction} offset ${position.spreadOffset} - ` +
                    `old order was matched during cancel attempt`
                );
                position.sellOrder = oldOrder;
                return true;
            }

            // Old order was successfully canceled, create new one
            position.sellOrder = undefined;

            // Create new sell order at updated price
            const sellOrderName = `mm-sell-repriced-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;
            const newSellOrder = await this.makeOrder(
                sellOrderName,
                tokenId,
                newSellPrice,
                updatedRemaining,
                Side.SELL
            );

            if (newSellOrder) {
                position.sellOrder = newSellOrder;
                position.sellOrderHistory.push(newSellOrder.orderId);
                position.sellOrderCreatedAt = this.clock.now();
            }

            return true;
        } catch (error) {
            this.writeError(`Error checking sell timeout for ${direction}: ${error}`);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Sell Order Creation
    // -------------------------------------------------------------------------

    private async createSellOrdersForMatchedBuys(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        // Create sells for matched UP buys
        for (const [_, position] of this.upPositions) {
            if (this.positionNeedsSellOrder(position)) {
                await this.createSellForPosition(position, orderBooks.BtcUpTokenId, 'UP');
            }
        }

        // Create sells for matched DOWN buys
        for (const [_, position] of this.downPositions) {
            if (this.positionNeedsSellOrder(position)) {
                await this.createSellForPosition(position, orderBooks.BtcDownTokenId, 'DOWN');
            }
        }
    }

    private positionNeedsSellOrder(position: ActivePosition): boolean {
        // Must have matched buy
        if (position.buyOrder.status !== TradeStatus.MATCHED) return false;

        // CRITICAL: Check if all tokens already sold
        if (position.tokensSold >= position.buyOrder.amount) return false;

        // No sell order yet
        if (!position.sellOrder) return true;

        // Sell order was canceled (retry needed)
        if (position.sellOrder.status === TradeStatus.CANCELED) return true;

        return false;
    }

    private async createSellForPosition(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<void> {
        // CRITICAL: Check remaining tokens to sell
        const remainingTokens = position.buyOrder.amount - position.tokensSold;
        if (remainingTokens <= 0) {
            this.writeLog(
                `SKIP SELL: ${direction} offset ${position.spreadOffset} - ` +
                `all ${position.tokensSold} tokens already sold`
            );
            return;
        }

        let sellPrice: number;
        let orderNamePrefix: string;

        if (position.stopLossTriggered) {
            // Emergency exit - sell at current market bid minus buffer
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);
            sellPrice = Math.max(0.01, currentBidPrice - 0.01);
            orderNamePrefix = 'mm-stoploss';
            // this.writeLog(
            //     `Retrying stop-loss sell for ${direction} position: ` +
            //     `entry=${position.entryPrice.toFixed(2)}, ` +
            //     `emergency sell=${sellPrice.toFixed(2)}`
            // );
        } else {
            // Regular profit sell
            sellPrice = Math.min(
                Math.round((position.entryPrice + this.profitMargin) * 100) / 100,
                this.MAX_SELL_PRICE
            );
            orderNamePrefix = 'mm-sell';
            // this.writeLog(
            //     `Creating sell for ${direction} position: ` +
            //     `entry=${position.entryPrice.toFixed(2)}, ` +
            //     `sell=${sellPrice.toFixed(2)}, ` +
            //     `margin=${this.profitMargin.toFixed(2)}`
            // );
        }

        const sellOrderName = `${orderNamePrefix}-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;

        const newSellOrder = await this.makeOrder(
            sellOrderName,
            tokenId,
            sellPrice,
            remainingTokens,
            Side.SELL
        );

        if (newSellOrder) {
            position.sellOrder = newSellOrder;
            position.sellOrderHistory.push(newSellOrder.orderId);
            position.sellOrderCreatedAt = this.clock.now();
            if (position.stopLossTriggered) {
                position.stoplossCreatedAt = this.clock.now();
            }
        }
    }

    // -------------------------------------------------------------------------
    // Trade Recycling
    // -------------------------------------------------------------------------

    private async handleCompletedSells(): Promise<void> {
        if (this.isPastCutoff) return;

        const completedUpPositions: { offset: number, direction: TokenDirection }[] = [];
        const completedDownPositions: { offset: number, direction: TokenDirection }[] = [];

        // Find completed UP positions (all tokens sold)
        for (const [_, position] of this.upPositions) {
            // A position is complete when all tokens have been sold
            if (position.tokensSold >= position.buyOrder.amount) {
                completedUpPositions.push({
                    offset: position.spreadOffset,
                    direction: 'UP'
                });
            }
        }

        // Find completed DOWN positions (all tokens sold)
        for (const [_, position] of this.downPositions) {
            // A position is complete when all tokens have been sold
            if (position.tokensSold >= position.buyOrder.amount) {
                completedDownPositions.push({
                    offset: position.spreadOffset,
                    direction: 'DOWN'
                });
            }
        }

        // Remove completed positions and recycle
        for (const completed of completedUpPositions) {
            const key = this.getPositionKey('UP', completed.offset);
            const position = this.upPositions.get(key);
            if (position) {
                this.writeLog(
                    `RECYCLE: UP offset ${completed.offset} - ` +
                    `sold ${position.tokensSold}/${position.buyOrder.amount} tokens via ${position.sellOrderHistory.length} orders`
                );
            }
            this.upPositions.delete(key);
            await this.placeSpreadBuyOrder('UP', completed.offset);
        }

        for (const completed of completedDownPositions) {
            const key = this.getPositionKey('DOWN', completed.offset);
            const position = this.downPositions.get(key);
            if (position) {
                this.writeLog(
                    `RECYCLE: DOWN offset ${completed.offset} - ` +
                    `sold ${position.tokensSold}/${position.buyOrder.amount} tokens via ${position.sellOrderHistory.length} orders`
                );
            }
            this.downPositions.delete(key);
            await this.placeSpreadBuyOrder('DOWN', completed.offset);
        }
    }

    // -------------------------------------------------------------------------
    // Spread Order Placement
    // -------------------------------------------------------------------------

    private async refreshSpreadOrders(): Promise<void> {
        // const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        // Get current market prices for both tokens
        // const upAskPrice = await this.marketInfo.getPrice(orderBooks.BtcUpTokenId, Side.BUY, this.targetedMarket);
        // const downAskPrice = await this.marketInfo.getPrice(orderBooks.BtcDownTokenId, Side.BUY, this.targetedMarket);

        const activeCount = this.countActiveTrades();
        const slotsAvailable = this.totalActiveTrades - activeCount;

        if (slotsAvailable <= 0) return;

        // this.writeLog(
        //     `Refreshing spread: ${slotsAvailable} slots available, ` +
        //     `UP ask=${upAskPrice.toFixed(2)}, DOWN ask=${downAskPrice.toFixed(2)}`
        // );

        // Place orders for both UP and DOWN tokens at each spread level
        // Alternate between UP and DOWN to balance positions
        let ordersPlaced = 0;

        for (let offset = 1; offset <= this.spreadSize && ordersPlaced < slotsAvailable; offset++) {
            // Try UP order at this offset
            const upKey = this.getPositionKey('UP', offset);
            if (!this.upPositions.has(upKey)) {
                const placed = await this.placeSpreadBuyOrder('UP', offset);
                if (placed) {
                    ordersPlaced++;
                    if (ordersPlaced >= slotsAvailable) break;
                }
            }

            // Try DOWN order at this offset
            const downKey = this.getPositionKey('DOWN', offset);
            if (!this.downPositions.has(downKey) && ordersPlaced < slotsAvailable) {
                const placed = await this.placeSpreadBuyOrder('DOWN', offset);
                if (placed) {
                    ordersPlaced++;
                }
            }
        }
    }

    private async placeSpreadBuyOrder(
        direction: TokenDirection,
        spreadOffset: number
    ): Promise<boolean> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = direction === 'UP' ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId;

        // Get current ask price
        const currentAskPrice = await this.marketInfo.getPrice(tokenId, Side.BUY, this.targetedMarket);

        // Calculate buy price: current price - minSpreadDistance - ((offset - 1) * step)
        const buyPrice = Math.round((currentAskPrice - this.minSpreadDistance - ((spreadOffset - 1) * this.SPREAD_STEP)) * 100) / 100;

        // Check price bounds
        if (buyPrice < this.minPrice) {
            // this.writeLog(`${direction} buy at ${buyPrice.toFixed(2)} below minPrice ${this.minPrice}, skipping`);
            return false;
        }
        if (buyPrice > this.maxPrice) {
            // this.writeLog(`${direction} buy at ${buyPrice.toFixed(2)} above maxPrice ${this.maxPrice}, skipping`);
            return false;
        }

        // Check for conflicting sell order at same price
        if (this.hasLiveSellAtPrice(buyPrice, tokenId)) {
            this.writeLog(`${direction} buy at ${buyPrice.toFixed(2)} conflicts with existing SELL order, skipping`);
            return false;
        }

        // Calculate position size
        const positionSize = this.calculateValidPositionSize(buyPrice);
        if (positionSize === null) {
            // this.writeLog(`Cannot create ${direction} order: position size calculation failed`);
            return false;
        }

        const totalCost = buyPrice * positionSize;
        if (!this.canSpendFromBudget(totalCost)) {
            // this.writeLog(`Cannot create ${direction} order: would exceed hourly budget`);
            return false;
        }

        // Calculate stop-loss price
        const stopLossPrice = Math.max(0.01, buyPrice - this.stopLossAmount);

        const orderName = `mm-buy-${direction.toLowerCase()}-${spreadOffset}-${this.clock.now()}`;

        // this.writeLog(
        //     `Placing ${direction} buy: price=${buyPrice.toFixed(2)}, ` +
        //     `offset=${spreadOffset}, size=${positionSize}, ` +
        //     `stop=${stopLossPrice.toFixed(2)}`
        // );

        const buyOrder = await this.makeOrder(
            orderName,
            tokenId,
            buyPrice,
            positionSize,
            Side.BUY
        );

        if (buyOrder) {
            const position: ActivePosition = {
                buyOrder,
                entryPrice: buyPrice,
                spreadOffset,
                tokenDirection: direction,
                stopLossPrice,
                tokensSold: 0,
                sellOrderHistory: []
            };

            const key = this.getPositionKey(direction, spreadOffset);
            if (direction === 'UP') {
                this.upPositions.set(key, position);
            } else {
                this.downPositions.set(key, position);
            }

            return true;
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Volatility Calculation
    // -------------------------------------------------------------------------

    private async calculateVolatility(): Promise<number> {
        try {
            const cdMarketData = this.getCdMarketData();
            const recentPrices = cdMarketData.getRecentPrices(
                this.volatilityLookbackPeriods,
                this.targetedMarket
            );

            if (recentPrices.length < 2) {
                return 0;
            }

            // Calculate price changes
            const changes: number[] = [];
            for (let i = 1; i < recentPrices.length; i++) {
                const change = recentPrices[i].price - recentPrices[i - 1].price;
                changes.push(change);
            }

            if (changes.length === 0) return 0;

            // Calculate standard deviation of changes
            const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
            const squaredDiffs = changes.map(c => Math.pow(c - mean, 2));
            const variance = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
            const stdDev = Math.sqrt(variance);

            // Normalize to a volatility scalar (dollars of movement)
            return stdDev;
        } catch (error) {
            this.writeError(`Error calculating volatility: ${error}`);
            return 0;
        }
    }

    // -------------------------------------------------------------------------
    // Position Sizing
    // -------------------------------------------------------------------------

    private calculateValidPositionSize(price: number): number | null {
        // Convert dollar amount to token quantity
        let size = this.dollarToTokens(this.targetDollars, price);
        if (size === null) {
            return null;
        }

        if (!this.checkIfOrderIsValid(price, size)) {
            return null;
        }

        const totalCost = price * size;
        if (!this.canSpend(totalCost)) {
            return null;
        }

        return size;
    }

    // -------------------------------------------------------------------------
    // Conflict Detection
    // -------------------------------------------------------------------------

    private hasLiveSellAtPrice(price: number, tokenId: string): boolean {
        for (const trade of this.trades) {
            if (
                trade.status === TradeStatus.LIVE &&
                trade.side === Side.SELL &&
                trade.clobTokenId === tokenId &&
                trade.targetSellPrice === price
            ) {
                return true;
            }
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        const currentMinute = this.clock.getMinutes();
        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return currentMinute % 15 >= this.cutoffMinute;
        } else {
            return currentMinute >= this.cutoffMinute;
        }
    }

    private async cancelAllLiveBuyOrders(): Promise<void> {
        // this.writeLog('Past cutoff - cancelling all live buy orders');

        for (const trade of this.trades) {
            if (trade.status === TradeStatus.LIVE && trade.side === Side.BUY) {
                await this.cancelTrade(trade);
            }
        }
    }
}
