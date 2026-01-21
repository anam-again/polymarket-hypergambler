import { Wallet } from "@ethersproject/wallet";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider } from "@ethersproject/providers";
import fetch from 'node-fetch';

import dotenv from 'dotenv';

// CTFExchange contract ABI (only the redeemPositions function we need)
const CTF_EXCHANGE_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
];

// Polymarket contract addresses on Polygon
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const POLYGON_RPC = "https://polygon-rpc.com";

interface Position {
    conditionId: string;
    asset: string;
    size: number;
    outcome: string;
    title: string;
    redeemable: boolean;
    currentValue: number;
    cashPnl: number;
}

interface RedeemResult {
    conditionId: string;
    success: boolean;
    txHash?: string;
    error?: string;
}

export interface RedeemerConfig {
    intervalHours?: number;
    rpcUrl?: string;
}

export class Redeemer {
    private wallet: Wallet;
    private walletAddress: string;
    private intervalHours: number;
    private intervalId?: ReturnType<typeof setInterval>;
    private isRunning: boolean = false;
    private ctfExchange: Contract;

    constructor(config: RedeemerConfig) {
        const provider = new JsonRpcProvider(config.rpcUrl ?? POLYGON_RPC);

        dotenv.config();

        const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
        const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;

        if (!privateKey) {
            throw new Error("POLYMARKET_PRIVATE_KEY environment variable is required");
        }
        if (!funderAddress) {
            throw new Error("POLYMARKET_FUNDER_ADDRESS environment variable is required");
        }

        this.wallet = new Wallet(privateKey, provider);
        this.walletAddress = funderAddress;
        this.intervalHours = config.intervalHours ?? 1;
        this.ctfExchange = new Contract(CTF_EXCHANGE_ADDRESS, CTF_EXCHANGE_ABI, this.wallet);
    }

    /**
     * Fetches all redeemable positions for the wallet
     */
    public async getRedeemablePositions(): Promise<Position[]> {
        console.log('hello')
        try {
            console.log('hello2')
            const response = await fetch(
                `https://data-api.polymarket.com/positions?user=${this.walletAddress}`
            );

            console.log(response);

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const res = await response.json() as Position[];
            if (!res || res.length < 1) {
                return [];
            }

            const redeemable = res.filter(pos => pos.redeemable === true);
            return redeemable;
        } catch (error) {
            console.error('[Redeemer] Failed to fetch positions:', error);
            throw error;
        }
    }

    /**
     * Redeems a single position by condition ID
     * For binary markets, indexSets is [1, 2] to redeem both outcomes
     */
    private async redeemPosition(conditionId: string): Promise<RedeemResult> {
        try {
            // Convert condition ID to bytes32 format if needed
            const conditionIdBytes32 = conditionId.startsWith('0x')
                ? conditionId
                : `0x${conditionId}`;

            // Parent collection ID is typically 0 for top-level conditions
            const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";

            // For binary markets, we redeem both outcomes (index sets 1 and 2)
            const indexSets = [1, 2];

            const tx = await this.ctfExchange.redeemPositions(
                USDC_ADDRESS,
                parentCollectionId,
                conditionIdBytes32,
                indexSets,
            );

            const receipt = await tx.wait();

            return {
                conditionId,
                success: true,
                txHash: receipt.transactionHash
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[Redeemer] Failed to redeem position ${conditionId}:`, errorMessage);

            return {
                conditionId,
                success: false,
                error: errorMessage
            };
        }
    }

    /**
     * Redeems all redeemable positions for the wallet
     */
    public async redeemAll(): Promise<RedeemResult[]> {
        console.log(`[Redeemer] Checking for redeemable positions for wallet ${this.walletAddress}`);

        const redeemablePositions = await this.getRedeemablePositions();

        if (redeemablePositions.length === 0) {
            console.log('[Redeemer] No redeemable positions found');
            return [];
        }

        console.log(`[Redeemer] Found ${redeemablePositions.length} redeemable positions:`);
        redeemablePositions.forEach(pos => {
            console.log(`  - ${pos.title} (${pos.outcome}): ${pos.size} shares, PnL: $${pos.cashPnl.toFixed(2)}`);
        });

        const results: RedeemResult[] = [];

        // Get unique condition IDs (multiple positions may share the same condition)
        const uniqueConditionIds = Array.from(new Set(redeemablePositions.map(p => p.conditionId)));

        for (const conditionId of uniqueConditionIds) {
            const result = await this.redeemPosition(conditionId);
            results.push(result);

            if (result.success) {
                console.log(`[Redeemer] Successfully redeemed condition ${conditionId} (tx: ${result.txHash})`);
            } else {
                console.log(`[Redeemer] Failed to redeem condition ${conditionId}: ${result.error}`);
            }

            // Small delay between redemptions to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const successCount = results.filter(r => r.success).length;
        console.log(`[Redeemer] Redemption complete: ${successCount}/${results.length} successful`);

        return results;
    }

    /**
     * Starts the automatic hourly redemption process
     */
    public run(): void {
        if (this.isRunning) {
            console.log('[Redeemer] Already running');
            return;
        }

        this.isRunning = true;
        const intervalMs = this.intervalHours * 60 * 60 * 1000;

        console.log(`[Redeemer] Starting automatic redemption every ${this.intervalHours} hour(s)`);

        // Run immediately on start
        this.redeemAll().catch(err => {
            console.error('[Redeemer] Error during initial redemption:', err);
        });

        // Schedule hourly runs
        this.intervalId = setInterval(() => {
            this.redeemAll().catch(err => {
                console.error('[Redeemer] Error during scheduled redemption:', err);
            });
        }, intervalMs);
    }

    /**
     * Stops the automatic redemption process
     */
    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.isRunning = false;
        console.log('[Redeemer] Stopped automatic redemption');
    }
}
