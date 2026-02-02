import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";

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
    requiredVolatility: number;   // Maximum volatility scalar to enter trades (skip if exceeded)
    volatilityLookbackPeriods: number;  // Periods to measure volatility

    // Standard parameters
    targetSize: number;           // Position size per level
    cutoffMinute: number;         // Stop new trades after this minute
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
    private requiredVolatility: number;
    private volatilityLookbackPeriods: number;
    private targetSize: number;
    private cutoffMinute: number;

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
        this.requiredVolatility = props.requiredVolatility;
        this.volatilityLookbackPeriods = props.volatilityLookbackPeriods;
        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
    }

    // --- Main Run Loop ---

    public async run(): Promise<void> {
        this.setupPeriodReset();
        this.startTradingLoop();
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

        // 10. Check volatility filter (skip if too volatile)
        const volatility = await this.calculateVolatility();
        if (volatility > this.requiredVolatility) {
            this.writeLog(`Volatility ${volatility.toFixed(2)} > max ${this.requiredVolatility}, skipping new orders`);
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

        try {
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

            if (currentBidPrice <= position.stopLossPrice) {
                // Mark as stop-loss triggered (persists for retry)
                position.stopLossTriggered = true;

                this.writeLog(
                    `STOP-LOSS: ${direction} position at ${position.entryPrice.toFixed(2)} ` +
                    `triggered at ${currentBidPrice.toFixed(2)} (stop: ${position.stopLossPrice.toFixed(2)})`
                );

                // Cancel existing regular sell order if any
                if (position.sellOrder && position.sellOrder.status === TradeStatus.LIVE) {
                    await this.cancelTrade(position.sellOrder);
                    position.sellOrder = undefined;  // Clear so emergency sell can be created
                }

                // Attempt emergency sell (will retry via createSellOrdersForMatchedBuys if fails)
                if (!position.sellOrder) {
                    const emergencySellPrice = Math.max(0.01, currentBidPrice - 0.01);
                    const sellOrderName = `mm-stoploss-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;

                    position.sellOrder = await this.makeOrder(
                        sellOrderName,
                        tokenId,
                        emergencySellPrice,
                        position.buyOrder.amount,
                        Side.SELL
                    );
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

        try {
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

            // Case 1: Price recovered above entry - revert to regular profit sell
            if (currentBidPrice > position.entryPrice) {
                this.writeLog(
                    `STOP-LOSS RECOVERY: ${direction} position at ${position.entryPrice.toFixed(2)} ` +
                    `recovered to ${currentBidPrice.toFixed(2)}, reverting to profit sell`
                );

                // Cancel the stop-loss sell order if exists
                if (position.sellOrder && position.sellOrder.status === TradeStatus.LIVE) {
                    await this.cancelTrade(position.sellOrder);
                }

                // Reset stop-loss state so regular sell will be created
                position.stopLossTriggered = false;
                position.sellOrder = undefined;

                return true;
            }

            // Case 2: Price in "danger zone" (above stop-loss but below entry)
            // Update emergency sell price if it's become stale
            if (currentBidPrice > position.stopLossPrice && position.sellOrder?.status === TradeStatus.LIVE) {
                const currentSellPrice = position.sellOrder.targetSellPrice ?? 0;
                const optimalEmergencyPrice = Math.max(0.01, currentBidPrice - 0.01);

                // If current sell price is more than 2 cents below optimal, update it
                if (optimalEmergencyPrice - currentSellPrice >= 0.02) {
                    this.writeLog(
                        `STOP-LOSS UPDATE: ${direction} position updating emergency sell from ` +
                        `${currentSellPrice.toFixed(2)} to ${optimalEmergencyPrice.toFixed(2)} (bid=${currentBidPrice.toFixed(2)})`
                    );

                    // Cancel stale emergency sell
                    await this.cancelTrade(position.sellOrder);
                    position.sellOrder = undefined;

                    // Create updated emergency sell at current price
                    const sellOrderName = `mm-stoploss-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;
                    position.sellOrder = await this.makeOrder(
                        sellOrderName,
                        tokenId,
                        optimalEmergencyPrice,
                        position.buyOrder.amount,
                        Side.SELL
                    );

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

        position.sellOrder = await this.makeOrder(
            sellOrderName,
            tokenId,
            sellPrice,
            position.buyOrder.amount,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Trade Recycling
    // -------------------------------------------------------------------------

    private async handleCompletedSells(): Promise<void> {
        if (this.isPastCutoff) return;

        const completedUpPositions: { offset: number, direction: TokenDirection }[] = [];
        const completedDownPositions: { offset: number, direction: TokenDirection }[] = [];

        // Find completed UP positions
        for (const [_, position] of this.upPositions) {
            if (position.sellOrder?.status === TradeStatus.MATCHED) {
                completedUpPositions.push({
                    offset: position.spreadOffset,
                    direction: 'UP'
                });
            }
        }

        // Find completed DOWN positions
        for (const [_, position] of this.downPositions) {
            if (position.sellOrder?.status === TradeStatus.MATCHED) {
                completedDownPositions.push({
                    offset: position.spreadOffset,
                    direction: 'DOWN'
                });
            }
        }

        // Remove completed positions and recycle
        for (const completed of completedUpPositions) {
            const key = this.getPositionKey('UP', completed.offset);
            this.upPositions.delete(key);
            // this.writeLog(`Recycling UP position at offset ${completed.offset}`);
            await this.placeSpreadBuyOrder('UP', completed.offset);
        }

        for (const completed of completedDownPositions) {
            const key = this.getPositionKey('DOWN', completed.offset);
            this.downPositions.delete(key);
            // this.writeLog(`Recycling DOWN position at offset ${completed.offset}`);
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
                stopLossPrice
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
        let size = this.targetSize;

        if (size < this.MIN_ORDER_SIZE) {
            size = this.MIN_ORDER_SIZE;
        }

        if (price * size < this.MIN_ORDER_VALUE) {
            size = Math.ceil(this.MIN_ORDER_VALUE / price);
        }

        if (size < this.MIN_ORDER_SIZE) {
            size = this.MIN_ORDER_SIZE;
        }

        if (!this.checkIfOrderIsValid(price, size)) {
            // this.writeLog('Ordeer is  invalid')
            return null;
        }

        const totalCost = price * size;
        if (!this.canSpend(totalCost)) {
            // this.writeLog('Out of budget')
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
