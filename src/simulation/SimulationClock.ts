/**
 * SimulationClock manages virtual time for historical simulations.
 * It allows advancing time in configurable increments and provides
 * the same time interface that bots expect.
 */
export class SimulationClock {
    private currentTime: number;
    private readonly startTime: number;
    private readonly endTime: number;
    private readonly incrementMs: number;

    private hourChangeListeners: (() => void)[] = [];

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
     */
    public tick(): boolean {
        const previousHour = new Date(this.currentTime).getHours();

        this.currentTime += this.incrementMs;

        if (this.currentTime > this.endTime) {
            this.currentTime = this.endTime;
            return false;
        }

        const currentHour = new Date(this.currentTime).getHours();
        if (currentHour !== previousHour) {
            this.emitHourChange();
        }

        return true;
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
     * Register a listener for hour changes.
     */
    public onHourChange(listener: () => void): void {
        this.hourChangeListeners.push(listener);
    }

    /**
     * Remove all hour change listeners.
     */
    public clearHourChangeListeners(): void {
        this.hourChangeListeners = [];
    }

    private emitHourChange(): void {
        for (const listener of this.hourChangeListeners) {
            listener();
        }
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
