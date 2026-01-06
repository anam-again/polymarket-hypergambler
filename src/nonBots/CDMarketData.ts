import cron from 'node-cron';
import { QuantBotRun } from "./../bots/QuantBot.js";

import dotenv from 'dotenv';
import { appendFileSync } from 'fs';

export class CDMarketData implements QuantBotRun {

    private cronJob: cron.ScheduledTask | null = null;
    private COINDESK_API_KEY: string;

    constructor() {
        dotenv.config();
        const COINDESK_API_KEY = process.env.COINDESK_API_KEY;
        if (!COINDESK_API_KEY) {
            throw Error("COINDESK_API_KEY must be supplied in  process.env");
        }
        this.COINDESK_API_KEY = COINDESK_API_KEY;
    }

    public async run() {
        this.startCronJob();
    }

    private startCronJob() {
        this.cronJob = cron.schedule('55 * * * *', async () => {
            await this.runHourlyData();
        });
    }

    public async getCurrentPrice(): Promise<number> {
        const url = `https://data-api.coindesk.com/index/cc/v1/latest/tick?market=cadli&instruments=BTC-USD&apply_mapping=true&groups=VALUE&api_key=${this.COINDESK_API_KEY}`
        let data;
        for (let i = 0; i < 5; i++) {
            const response = await fetch(url);
            if (!response.ok) {
                // todo
                this.writeError(`Failed to get current data for url: ${url}`)
            }
            data = await response.json();
        }
        const jsonData = (data as
            {
                Data?: {
                    ["BTC-USD"]: {
                        VALUE: string,
                    }
                }
            }
        );
        const value = jsonData.Data?.['BTC-USD'].VALUE
        if (!value) {
            this.writeError(`Failed to parse market data from input: ${data}`);
            throw Error(`Failed to parse market data from input: ${data}`)
        }
        const nValue = parseFloat(value);
        if (!nValue) {
            this.writeError(`Failed to parse market data from input: ${data}`);
            throw Error(`Failed to parse market data from input: ${data}`)
        }
        return nValue;
    }


    private async runHourlyData() {
        const url = `https://data-api.coindesk.com/index/cc/v1/latest/tick?market=cadli&instruments=BTC-USD&apply_mapping=true&groups=CURRENT_HOUR&api_key=${this.COINDESK_API_KEY}`
        let data;
        for (let i = 0; i < 5; i++) {
            const response = await fetch(url);
            if (!response.ok) {
                // todo
                this.writeError(`Failed to get hourly data for url: ${url}`)
            }
            data = await response.json();
        }
        const jsonData = (data as
            {
                Data?: {
                    ["BTC-USD"]: {
                        CURRENT_HOUR_OPEN: string,
                        CURRENT_HOUR_CHANGE: string,
                    }
                }
            }
        );
        if (!jsonData) {
            this.writeError(`Failed to parse market data from input: ${data}`);
        }
        const writeMessage = [
            jsonData.Data?.['BTC-USD'].CURRENT_HOUR_OPEN,
            jsonData.Data?.['BTC-USD'].CURRENT_HOUR_CHANGE,
        ].join(", ");
        this.writeData(writeMessage);
    }

    public stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }
    }

    private writeError(message: string): void {
        const timestamp = new Date().toISOString();
        const logLine = `${timestamp}\t ${message}\n`;
        appendFileSync(`./logs/CDMarketWriterError.log`, logLine);
    }

    /**
     * Writes a timestamped message to the error log file.
     * @param message - The message to log.
     */
    private writeData(message: string): void {
        const timestamp = new Date(new Date().setMinutes(0, 0, 0)).toISOString();
        const logLine = `${timestamp}, ${message}\n`
        appendFileSync(`./logs/CDMarketWriterData.log`, logLine);
    }

}