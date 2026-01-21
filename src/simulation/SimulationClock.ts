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

    constructor(startTime: number, endTime: number, incrementMs: number = 60 * 1000) {
        this.startTime = startTime;
        this.endTime = endTime;
        this.currentTime = startTime;
        this.incrementMs = incrementMs;
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

        const previousDate = new Date(this.currentTime);
        const previousHour = previousDate.getHours();
        const previousQuarter = Math.floor(previousDate.getMinutes() / 15);

        this.currentTime += this.incrementMs;

        if (this.currentTime > this.endTime) {
            this.currentTime = this.endTime;
            return false;
        }

        const currentDate = new Date(this.currentTime);
        const currentHour = currentDate.getHours();
        const currentQuarter = Math.floor(currentDate.getMinutes() / 15);

        // Emit quarterly event (also triggers at hour boundaries)
        if (currentHour !== previousHour || currentQuarter !== previousQuarter) {
            await this.emitQuarterlyChange();
        }

        // Emit hourly event
        if (currentHour !== previousHour) {
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
     */
    public getMinutes(): number {
        return new Date(this.currentTime).getMinutes();
    }

    /**
     * Gets the current hour (0-23).
     */
    public getHours(): number {
        return new Date(this.currentTime).getHours();
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
