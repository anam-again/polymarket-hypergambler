import { ClobClient, OpenOrder, OrderResponse, OrderType, Side } from "@polymarket/clob-client";

// SignedOrder type from the client's createOrder method
type SignedOrder = Awaited<ReturnType<ClobClient['createOrder']>>;

// ============================================================================
// Order Batcher Types
// ============================================================================

interface GetOrderRequest {
  orderId: string;
  resolve: (result: OpenOrder | undefined) => void;
  reject: (error: Error) => void;
}

interface CancelOrderRequest {
  orderId: string;
  resolve: (success: boolean) => void;
  reject: (error: Error) => void;
}

interface CreateOrderRequest {
  tokenID: string;
  price: number;
  side: Side;
  size: number;
  feeRateBps: number;
  resolve: (result: OrderResponse) => void;
  reject: (error: Error) => void;
}

// ============================================================================
// Order Batcher Class (Static)
// ============================================================================

/**
 * OrderBatcher provides static methods for batching order operations across
 * multiple QuantBot instances. This reduces API calls by collecting requests
 * over a short window and executing them together.
 *
 * Individual failures don't affect other requests in the batch - each caller
 * receives their own result or error.
 */
export class OrderBatcher {
  private static client: ClobClient | null = null;
  private static batchWindowMs: number = 200;

  // Queues for batching requests
  private static getOrderQueue: GetOrderRequest[] = [];
  private static cancelOrderQueue: CancelOrderRequest[] = [];
  private static createOrderQueue: CreateOrderRequest[] = [];

  // Timers for batch execution
  private static getOrderTimer: ReturnType<typeof setTimeout> | null = null;
  private static cancelOrderTimer: ReturnType<typeof setTimeout> | null = null;
  private static createOrderTimer: ReturnType<typeof setTimeout> | null = null;

  // Processing flags to prevent concurrent batch execution
  private static isProcessingGetOrders: boolean = false;
  private static isProcessingCancelOrders: boolean = false;
  private static isProcessingCreateOrders: boolean = false;

  /**
   * Initialize the batcher with a ClobClient instance.
   * Must be called before using any batch methods.
   */
  public static initialize(client: ClobClient, batchWindowMs: number = 200): void {
    OrderBatcher.client = client;
    OrderBatcher.batchWindowMs = batchWindowMs;
  }

  /**
   * Batch-enabled getOrder. Collects multiple getOrder requests and executes
   * them together. Each request returns independently.
   */
  public static async getOrder(orderId: string): Promise<OpenOrder | undefined> {
    if (!OrderBatcher.client) {
      throw new Error('OrderBatcher not initialized. Call OrderBatcher.initialize(client) first.');
    }

    return new Promise((resolve, reject) => {
      OrderBatcher.getOrderQueue.push({ orderId, resolve, reject });
      OrderBatcher.scheduleGetOrderBatch();
    });
  }

  /**
   * Batch-enabled cancelOrder. Collects multiple cancel requests and executes
   * them together using cancelOrders API.
   */
  public static async cancelOrder(orderId: string): Promise<boolean> {
    if (!OrderBatcher.client) {
      throw new Error('OrderBatcher not initialized. Call OrderBatcher.initialize(client) first.');
    }

    return new Promise((resolve, reject) => {
      OrderBatcher.cancelOrderQueue.push({ orderId, resolve, reject });
      OrderBatcher.scheduleCancelOrderBatch();
    });
  }

  /**
   * Batch-enabled createAndPostOrder. Collects multiple create requests and
   * executes them together.
   */
  public static async createAndPostOrder(
    tokenID: string,
    price: number,
    side: Side,
    size: number,
    feeRateBps: number = 0
  ): Promise<OrderResponse> {
    if (!OrderBatcher.client) {
      throw new Error('OrderBatcher not initialized. Call OrderBatcher.initialize(client) first.');
    }

    return new Promise((resolve, reject) => {
      OrderBatcher.createOrderQueue.push({ tokenID, price, side, size, feeRateBps, resolve, reject });
      OrderBatcher.scheduleCreateOrderBatch();
    });
  }

  /**
   * Process all pending batches immediately (useful for testing or shutdown).
   */
  public static async flush(): Promise<void> {
    if (OrderBatcher.getOrderTimer) {
      clearTimeout(OrderBatcher.getOrderTimer);
      OrderBatcher.getOrderTimer = null;
    }
    if (OrderBatcher.cancelOrderTimer) {
      clearTimeout(OrderBatcher.cancelOrderTimer);
      OrderBatcher.cancelOrderTimer = null;
    }
    if (OrderBatcher.createOrderTimer) {
      clearTimeout(OrderBatcher.createOrderTimer);
      OrderBatcher.createOrderTimer = null;
    }

    await Promise.all([
      OrderBatcher.processGetOrderBatch(),
      OrderBatcher.processCancelOrderBatch(),
      OrderBatcher.processCreateOrderBatch(),
    ]);
  }

  /**
   * Clear all pending requests (rejects them with cancellation error).
   */
  public static clear(): void {
    const error = new Error('OrderBatcher cleared');

    OrderBatcher.getOrderQueue.forEach(req => req.reject(error));
    OrderBatcher.cancelOrderQueue.forEach(req => req.reject(error));
    OrderBatcher.createOrderQueue.forEach(req => req.reject(error));

    OrderBatcher.getOrderQueue = [];
    OrderBatcher.cancelOrderQueue = [];
    OrderBatcher.createOrderQueue = [];

    if (OrderBatcher.getOrderTimer) clearTimeout(OrderBatcher.getOrderTimer);
    if (OrderBatcher.cancelOrderTimer) clearTimeout(OrderBatcher.cancelOrderTimer);
    if (OrderBatcher.createOrderTimer) clearTimeout(OrderBatcher.createOrderTimer);

    OrderBatcher.getOrderTimer = null;
    OrderBatcher.cancelOrderTimer = null;
    OrderBatcher.createOrderTimer = null;
  }

  // -------------------------------------------------------------------------
  // Private: Scheduling
  // -------------------------------------------------------------------------

  private static scheduleGetOrderBatch(): void {
    if (OrderBatcher.getOrderTimer) return;

    OrderBatcher.getOrderTimer = setTimeout(() => {
      OrderBatcher.getOrderTimer = null;
      OrderBatcher.processGetOrderBatch();
    }, OrderBatcher.batchWindowMs);
  }

  private static scheduleCancelOrderBatch(): void {
    if (OrderBatcher.cancelOrderTimer) return;

    OrderBatcher.cancelOrderTimer = setTimeout(() => {
      OrderBatcher.cancelOrderTimer = null;
      OrderBatcher.processCancelOrderBatch();
    }, OrderBatcher.batchWindowMs);
  }

  private static scheduleCreateOrderBatch(): void {
    if (OrderBatcher.createOrderTimer) return;

    OrderBatcher.createOrderTimer = setTimeout(() => {
      OrderBatcher.createOrderTimer = null;
      OrderBatcher.processCreateOrderBatch();
    }, OrderBatcher.batchWindowMs);
  }

  // -------------------------------------------------------------------------
  // Private: Batch Processing
  // -------------------------------------------------------------------------

  private static async processGetOrderBatch(): Promise<void> {
    if (OrderBatcher.isProcessingGetOrders || OrderBatcher.getOrderQueue.length === 0) return;

    OrderBatcher.isProcessingGetOrders = true;
    const batch = [...OrderBatcher.getOrderQueue];
    OrderBatcher.getOrderQueue = [];

    try {
      // Process each getOrder individually but in parallel
      // The CLOB client doesn't have a batch getOrders method
      const results = await Promise.allSettled(
        batch.map(async (req) => {
          try {
            const result = await OrderBatcher.client!.getOrder(req.orderId);
            return { req, result, error: null };
          } catch (error) {
            return { req, result: null, error };
          }
        })
      );

      // Distribute results to callers
      for (const settled of results) {
        if (settled.status === 'fulfilled') {
          const { req, result, error } = settled.value;
          if (error) {
            req.reject(error instanceof Error ? error : new Error(String(error)));
          } else {
            req.resolve(result as OpenOrder | undefined);
          }
        } else {
          // This shouldn't happen since we catch errors above, but handle it
          const correspondingReq = batch.find(r => !results.some(
            s => s.status === 'fulfilled' && s.value.req === r
          ));
          correspondingReq?.reject(new Error(settled.reason));
        }
      }
    } finally {
      OrderBatcher.isProcessingGetOrders = false;

      // Process any requests that came in during processing
      if (OrderBatcher.getOrderQueue.length > 0) {
        OrderBatcher.scheduleGetOrderBatch();
      }
    }
  }

  private static async processCancelOrderBatch(): Promise<void> {
    if (OrderBatcher.isProcessingCancelOrders || OrderBatcher.cancelOrderQueue.length === 0) return;

    OrderBatcher.isProcessingCancelOrders = true;
    const batch = [...OrderBatcher.cancelOrderQueue];
    OrderBatcher.cancelOrderQueue = [];

    try {
      // Use batch cancel API
      const orderIds = batch.map(req => req.orderId);

      try {
        await OrderBatcher.client!.cancelOrders(orderIds);

        // All succeeded
        batch.forEach(req => req.resolve(true));
      } catch (batchError) {
        // Batch failed - fall back to individual cancellations
        console.warn('[OrderBatcher] Batch cancel failed, falling back to individual cancels:', batchError);

        const results = await Promise.allSettled(
          batch.map(async (req) => {
            try {
              await OrderBatcher.client!.cancelOrder({ orderID: req.orderId });
              return { req, success: true, error: null };
            } catch (error) {
              return { req, success: false, error };
            }
          })
        );

        for (const settled of results) {
          if (settled.status === 'fulfilled') {
            const { req, success, error } = settled.value;
            if (error) {
              req.reject(error instanceof Error ? error : new Error(String(error)));
            } else {
              req.resolve(success);
            }
          }
        }
      }
    } finally {
      OrderBatcher.isProcessingCancelOrders = false;

      if (OrderBatcher.cancelOrderQueue.length > 0) {
        OrderBatcher.scheduleCancelOrderBatch();
      }
    }
  }

  private static async processCreateOrderBatch(): Promise<void> {
    if (OrderBatcher.isProcessingCreateOrders || OrderBatcher.createOrderQueue.length === 0) return;

    OrderBatcher.isProcessingCreateOrders = true;
    const batch = [...OrderBatcher.createOrderQueue];
    OrderBatcher.createOrderQueue = [];

    try {
      // Create signed orders for batch submission
      const signedOrders: { req: CreateOrderRequest; order: SignedOrder }[] = [];

      // First, create all orders (this doesn't submit them yet)
      for (const req of batch) {
        try {
          const order = await OrderBatcher.client!.createOrder(
            {
              tokenID: req.tokenID,
              price: req.price,
              side: req.side,
              size: req.size,
              feeRateBps: req.feeRateBps,
            },
            { tickSize: "0.01", negRisk: false }
          );
          signedOrders.push({ req, order });
        } catch (error) {
          // Individual order creation failed
          req.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      if (signedOrders.length === 0) {
        return;
      }

      // Try to submit all orders in a batch
      try {
        const batchArgs = signedOrders.map(({ order }) => ({
          order,
          orderType: OrderType.GTC,
        }));

        const batchResult = await OrderBatcher.client!.postOrders(batchArgs);

        // Parse batch result and distribute to callers
        // The batch result format varies - handle both array and object responses
        if (Array.isArray(batchResult)) {
          for (let i = 0; i < signedOrders.length; i++) {
            const { req } = signedOrders[i];
            const result = batchResult[i];

            // Determine success: need orderID AND (success !== false) AND no error message
            const hasOrderId = result && result.orderID;
            const explicitFailure = result?.success === false;
            const hasErrorMsg = result?.errorMsg && result.errorMsg.length > 0;
            const hasErrorField = result?.error && result.error.length > 0;

            // Order is successful only if: has orderID, not explicitly failed, no error messages
            if (hasOrderId && !explicitFailure && !hasErrorMsg && !hasErrorField) {
              req.resolve({
                orderID: result.orderID,
                status: result.status || 'LIVE',
                success: true,
                errorMsg: '',
                makingAmount: '',
                takingAmount: '',
                transactionsHashes: result.transactionsHashes || [],
              });
            } else {
              // Order failed - extract the error message
              const errorMessage = result?.errorMsg || result?.error ||
                (explicitFailure ? 'Order explicitly failed' : 'Missing orderID');
              console.log('[OrderBatcher] Order failed:', errorMessage, JSON.stringify(result));
              req.reject(new Error(String(errorMessage)));
            }
          }
        } else {
          // Single response for batch - check if it indicates success
          const anyResult = batchResult as { success?: boolean; error?: string };
          if (anyResult.success === false || anyResult.error) {
            throw new Error(anyResult.error || 'Batch order submission failed');
          }

          // Fall back to individual submissions if batch response format is unclear
          throw new Error('Unclear batch response format, falling back to individual');
        }
      } catch (batchError) {
        // Batch submission failed - fall back to individual submissions
        console.warn('[OrderBatcher] Batch create failed, falling back to individual posts:', batchError);

        const results = await Promise.allSettled(
          signedOrders.map(async ({ req, order }) => {
            try {
              const result = await OrderBatcher.client!.postOrder(order, OrderType.GTC);
              return { req, result, error: null };
            } catch (error) {
              return { req, result: null, error };
            }
          })
        );

        for (const settled of results) {
          if (settled.status === 'fulfilled') {
            const { req, result, error } = settled.value;
            if (error) {
              req.reject(error instanceof Error ? error : new Error(String(error)));
            } else {
              req.resolve(result as OrderResponse);
            }
          }
        }
      }
    } finally {
      OrderBatcher.isProcessingCreateOrders = false;

      if (OrderBatcher.createOrderQueue.length > 0) {
        OrderBatcher.scheduleCreateOrderBatch();
      }
    }
  }
}
