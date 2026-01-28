import { IClock, ClockEventType } from '../types/interfaces.js';

// Listener can be sync or async
type ClockListener = () => void | Promise<void>;

/**
 * SimulationClock manages virtual time for historical simulations.
 * It allows advancing time in configurable increments and provides
 * the same time interface that bots expect.
 */
export class SimulationClock implements IClock {
    private currentTime: number;
    private readonly startTime: number;
    private readonly endTime: number;
    private readonly incrementMs: number;

    private hourlyListeners: ClockListener[] = [];
    private quarterlyListeners: ClockListener[] = [];

    // Track pending reset operations to prevent race conditions
    private pendingReset: Promise<void> | null = null;

    // Cached period boundaries for fast tick comparisons
    private nextHourBoundary: number;
    private nextQuarterBoundary: number;
    private cachedHour: number;
    private cachedMinutes: number;

    constructor(startTime: number, endTime: number, incrementMs: number = 10 * 1000) {
        this.startTime = startTime;
        this.endTime = endTime;
        this.currentTime = startTime;
        this.incrementMs = incrementMs;

        // Initialize cached boundaries
        const startDate = new Date(startTime);
        this.cachedHour = startDate.getHours();
        this.cachedMinutes = startDate.getMinutes();
        this.nextHourBoundary = this.computeNextHourBoundary(startTime);
        this.nextQuarterBoundary = this.computeNextQuarterBoundary(startTime);
    }

    /**
     * Computes the next hour boundary timestamp from a given time.
     */
    private computeNextHourBoundary(timestamp: number): number {
        const date = new Date(timestamp);
        date.setMinutes(0, 0, 0);
        date.setHours(date.getHours() + 1);
        return date.getTime();
    }

    /**
     * Computes the next 15-minute boundary timestamp from a given time.
     */
    private computeNextQuarterBoundary(timestamp: number): number {
        const date = new Date(timestamp);
        const currentQuarter = Math.floor(date.getMinutes() / 15);
        date.setMinutes((currentQuarter + 1) * 15, 0, 0);
        return date.getTime();
    }

    /**
     * Updates cached hour/minutes from current time (only called on boundary crossings).
     */
    private updateCachedTime(): void {
        const date = new Date(this.currentTime);
        this.cachedHour = date.getHours();
        this.cachedMinutes = date.getMinutes();
    }

    /**
     * Gets the current simulated timestamp in milliseconds.
     */
    public now(): number {
        return this.currentTime;
    }

    /**
     * Gets the current simulated time as a Date object.
     */
    public nowDate(): Date {
        return new Date(this.currentTime);
    }

    /**
     * Gets the current EST timestamp (simulated).
     */
    public getCurrentEstTimestamp(): number {
        const estString = new Date(this.currentTime).toLocaleString("en-US", { timeZone: "America/New_York" });
        return new Date(estString).getTime();
    }

    /**
     * Advances the clock by one increment.
     * @returns true if time was advanced, false if end time reached.
     * Note: This is now async to properly handle period change events.
     */
    public async tick(): Promise<boolean> {
        // Wait for any pending reset to complete before advancing time
        if (this.pendingReset) {
            await this.pendingReset;
        }

        this.currentTime += this.incrementMs;

        if (this.currentTime > this.endTime) {
            this.currentTime = this.endTime;
            return false;
        }

        // Check boundaries using simple numeric comparisons (no Date creation)
        const crossedQuarter = this.currentTime >= this.nextQuarterBoundary;
        const crossedHour = this.currentTime >= this.nextHourBoundary;

        // Emit quarterly event (also triggers at hour boundaries)
        if (crossedQuarter) {
            this.nextQuarterBoundary = this.computeNextQuarterBoundary(this.currentTime);
            this.updateCachedTime();
            await this.emitQuarterlyChange();
        }

        // Emit hourly event
        if (crossedHour) {
            this.nextHourBoundary = this.computeNextHourBoundary(this.currentTime);
            if (!crossedQuarter) {
                this.updateCachedTime();
            }
            await this.emitHourlyChange();
        }

        return true;
    }

    /**
     * Waits for any pending reset operation to complete.
     * Call this before performing operations that shouldn't race with resets.
     */
    public async waitForPendingReset(): Promise<void> {
        if (this.pendingReset) {
            await this.pendingReset;
        }
    }

    /**
     * Checks if the simulation has reached the end time.
     */
    public isComplete(): boolean {
        return this.currentTime >= this.endTime;
    }

    /**
     * Gets the progress as a percentage (0-100).
     */
    public getProgress(): number {
        const elapsed = this.currentTime - this.startTime;
        const total = this.endTime - this.startTime;
        return (elapsed / total) * 100;
    }

    /**
     * Gets the current minute of the hour (0-59).
     * Uses cached value when within the same quarter, otherwise computes.
     */
    public getMinutes(): number {
        // If we're past the next quarter boundary, we need fresh data
        if (this.currentTime >= this.nextQuarterBoundary) {
            return new Date(this.currentTime).getMinutes();
        }
        // Estimate minutes based on time elapsed since last boundary update
        // For most use cases, the cached value from last boundary is close enough
        // But for precise minute tracking, compute it
        return new Date(this.currentTime).getMinutes();
    }

    /**
     * Gets the current hour (0-23).
     * Uses cached value for performance.
     */
    public getHours(): number {
        // If we're past the next hour boundary, we need fresh data
        if (this.currentTime >= this.nextHourBoundary) {
            return new Date(this.currentTime).getHours();
        }
        return this.cachedHour;
    }

    /**
     * Register a callback for hourly or quarterly events.
     * Callbacks can be sync or async - async callbacks will be awaited.
     */
    public on(event: ClockEventType, callback: ClockListener): void {
        if (event === 'hourly') {
            this.hourlyListeners.push(callback);
        } else if (event === 'quarterly') {
            this.quarterlyListeners.push(callback);
        }
    }

    /**
     * Unregister a callback.
     */
    public off(event: ClockEventType, callback: ClockListener): void {
        if (event === 'hourly') {
            const index = this.hourlyListeners.indexOf(callback);
            if (index !== -1) {
                this.hourlyListeners.splice(index, 1);
            }
        } else if (event === 'quarterly') {
            const index = this.quarterlyListeners.indexOf(callback);
            if (index !== -1) {
                this.quarterlyListeners.splice(index, 1);
            }
        }
    }

    /**
     * Remove all listeners.
     */
    public clearListeners(): void {
        this.hourlyListeners = [];
        this.quarterlyListeners = [];
    }

    private async emitHourlyChange(): Promise<void> {
        const resetPromise = (async () => {
            for (const listener of this.hourlyListeners) {
                await listener();
            }
        })();

        this.pendingReset = resetPromise;
        await resetPromise;
        this.pendingReset = null;
    }

    private async emitQuarterlyChange(): Promise<void> {
        const resetPromise = (async () => {
            for (const listener of this.quarterlyListeners) {
                await listener();
            }
        })();

        this.pendingReset = resetPromise;
        await resetPromise;
        this.pendingReset = null;
    }

    /**
     * Resets the clock to the start time.
     */
    public reset(): void {
        this.currentTime = this.startTime;
        // Reset cached boundaries
        const startDate = new Date(this.startTime);
        this.cachedHour = startDate.getHours();
        this.cachedMinutes = startDate.getMinutes();
        this.nextHourBoundary = this.computeNextHourBoundary(this.startTime);
        this.nextQuarterBoundary = this.computeNextQuarterBoundary(this.startTime);
    }

    /**
     * Gets simulation time range info.
     */
    public getTimeRange(): { start: Date; end: Date; durationDays: number } {
        return {
            start: new Date(this.startTime),
            end: new Date(this.endTime),
            durationDays: (this.endTime - this.startTime) / (24 * 60 * 60 * 1000),
        };
    }
}
