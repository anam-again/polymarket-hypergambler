import cron from 'node-cron';
import { IClock, ClockEventType } from '../types/interfaces.js';

// ============================================================================
// RealClock - Production implementation of IClock
// ============================================================================

/**
 * Production clock implementation that uses real system time and cron scheduling.
 */
export class RealClock implements IClock {
    private hourlyListeners: Array<() => void> = [];
    private quarterlyListeners: Array<() => void> = [];
    private cronJobs: cron.ScheduledTask[] = [];

    constructor() {
        // Set up hourly cron job (at minute 0 of every hour)
        const hourlyJob = cron.schedule('0 * * * *', () => {
            this.hourlyListeners.forEach(listener => {
                try {
                    listener();
                } catch (e) {
                    console.error('[RealClock] Error in hourly listener:', e);
                }
            });
        });
        this.cronJobs.push(hourlyJob);

        // Set up quarterly cron job (at minutes 0, 15, 30, 45)
        const quarterlyJob = cron.schedule('0,15,30,45 * * * *', () => {
            this.quarterlyListeners.forEach(listener => {
                try {
                    listener();
                } catch (e) {
                    console.error('[RealClock] Error in quarterly listener:', e);
                }
            });
        });
        this.cronJobs.push(quarterlyJob);
    }

    /**
     * Returns current timestamp in milliseconds.
     */
    public now(): number {
        return Date.now();
    }

    /**
     * Returns current minute (0-59).
     */
    public getMinutes(): number {
        return new Date().getMinutes();
    }

    /**
     * Returns current hour (0-23).
     */
    public getHours(): number {
        return new Date().getHours();
    }

    /**
     * Returns current EST timestamp.
     */
    public getCurrentEstTimestamp(): number {
        const estString = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
        return new Date(estString).getTime();
    }

    /**
     * Register a callback for hourly or quarterly events.
     */
    public on(event: ClockEventType, callback: () => void): void {
        if (event === 'hourly') {
            this.hourlyListeners.push(callback);
        } else if (event === 'quarterly') {
            this.quarterlyListeners.push(callback);
        }
    }

    /**
     * Unregister a callback.
     */
    public off(event: ClockEventType, callback: () => void): void {
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
     * Stops all cron jobs. Call this when shutting down.
     */
    public stop(): void {
        this.cronJobs.forEach(job => job.stop());
        this.cronJobs = [];
        this.hourlyListeners = [];
        this.quarterlyListeners = [];
    }
}
