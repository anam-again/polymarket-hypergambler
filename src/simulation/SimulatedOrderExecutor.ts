import { Side } from '@polymarket/clob-client';
import { IOrderExecutor, IMarketInfo, OrderResult, OrderStatus, TargetedMarket } from '../types/interfaces.js';
import { SimulationClock } from './SimulationClock.js';

// ============================================================================
// SimulatedOrderExecutor
// ============================================================================

/**
 * Extended order result that includes creation timestamp for delay tracking.
 */
interface SimulatedOrder extends OrderResult {
    createdAt: number;  // Simulation clock timestamp when order was created
}

/**
 * Simulated order executor that tracks orders and determines fills
 * based on market prices during simulation.
 */
export class SimulatedOrderExecutor implements IOrderExecutor {
    private orders: Map<string, SimulatedOrder> = new Map();
    private orderIdCounter: number = 0;
    private clock: SimulationClock;
    private marketInfo: IMarketInfo;
    private targetedMarket: TargetedMarket;

    // Order delay configuration (simulates production API latency)
    private orderDelayMs: number;
    private static readonly DEFAULT_ORDER_DELAY_MS = 10 * 1000;  // 10 seconds

    constructor(
        clock: SimulationClock,
        marketInfo: IMarketInfo,
        targetedMarket: TargetedMarket,
        orderDelayMs?: number
    ) {
        this.clock = clock;
        this.marketInfo = marketInfo;
        this.targetedMarket = targetedMarket;
        this.orderDelayMs = orderDelayMs ?? SimulatedOrderExecutor.DEFAULT_ORDER_DELAY_MS;
    }

    /**
     * Creates and tracks a simulated order.
     * Orders cannot fill until the delay period has passed.
     */
    public async createOrder(
        tokenId: string,
        price: number,
        amount: number,
        side: Side
    ): Promise<OrderResult> {
        const orderId = `sim-${this.orderIdCounter++}-${this.clock.now()}`;

        const order: SimulatedOrder = {
            orderId,
            status: OrderStatus.LIVE,
            tokenId,
            price,
            amount,
            side,
            filledAmount: 0,
            createdAt: this.clock.now(),
        };

        this.orders.set(orderId, order);

        // Don't immediately check for fill - must wait for delay period
        // The order will be checked on subsequent ticks via checkAllOrderFills()

        return order;
    }

    /**
     * Cancels an existing order.
     */
    public async cancelOrder(orderId: string): Promise<boolean> {
        const order = this.orders.get(orderId);
        if (!order) {
            return false;
        }

        if (order.status === OrderStatus.LIVE) {
            order.status = OrderStatus.CANCELED;
            return true;
        }

        return false;
    }

    /**
     * Gets the current status of an order.
     */
    public async getOrderStatus(orderId: string): Promise<OrderResult | null> {
        return this.orders.get(orderId) ?? null;
    }

    /**
     * Gets all open orders.
     */
    public async getOpenOrders(): Promise<OrderResult[]> {
        return Array.from(this.orders.values()).filter(
            order => order.status === OrderStatus.LIVE
        );
    }

    /**
     * Called each simulation tick to check if orders should be filled.
     */
    public async checkAllOrderFills(): Promise<void> {
        for (const order of this.orders.values()) {
            if (order.status === OrderStatus.LIVE) {
                await this.checkOrderFill(order);
            }
        }
    }

    /**
     * Checks if a single order should be filled based on current market prices.
     * Orders must have passed the delay period before they can fill.
     */
    private async checkOrderFill(order: SimulatedOrder): Promise<void> {
        try {
            // Check if order has passed the delay period
            const orderAge = this.clock.now() - order.createdAt;
            if (orderAge < this.orderDelayMs) {
                // Order is still in delay period, cannot fill yet
                return;
            }

            // Get the current market price for this token
            const currentPrice = await this.marketInfo.getPrice(order.tokenId, order.side, this.targetedMarket);

            if (order.side === Side.BUY) {
                // Buy order fills when market ask price <= our bid price
                if (currentPrice <= order.price) {
                    order.status = OrderStatus.MATCHED;
                    order.filledAmount = order.amount;
                }
            } else {
                // Sell order fills when market bid price >= our ask price
                if (currentPrice >= order.price) {
                    order.status = OrderStatus.MATCHED;
                    order.filledAmount = order.amount;
                }
            }
        } catch (error) {
            // If we can't get a price, leave order as LIVE
            console.warn(`[SimulatedOrderExecutor] Error checking order fill: ${error}`);
        }
    }

    /**
     * Expires all remaining LIVE orders at the end of a period.
     */
    public expireAllOrders(): void {
        for (const order of this.orders.values()) {
            if (order.status === OrderStatus.LIVE) {
                order.status = OrderStatus.EXPIRED;
            }
        }
    }

    /**
     * Clears all orders (call at start of new period).
     */
    public clearOrders(): void {
        this.orders.clear();
    }

    /**
     * Gets all orders for auditing purposes.
     */
    public getAllOrders(): OrderResult[] {
        return Array.from(this.orders.values());
    }

    /**
     * Gets orders by status.
     */
    public getOrdersByStatus(status: OrderStatus): OrderResult[] {
        return Array.from(this.orders.values()).filter(
            order => order.status === status
        );
    }
}
