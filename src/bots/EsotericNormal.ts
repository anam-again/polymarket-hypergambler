import { CDMarketData } from "./../nonBots/CDMarketData.js";
import { QuantBot, QuantBotProps, QuantBotRun } from "./QuantBot.js";

interface EsotericNormalProps extends QuantBotProps {
    standardPriceDiff: number;
    timeElapsedLinearBound: number;
    sdevMagic: number;
    cdMarketData: CDMarketData;
}

export class EsotericNormal extends QuantBot implements QuantBotRun {

    private standardPriceDiff: number;
    private timeElapsedLinearBound: number;
    private sdevMagic: number;
    private cdMarketData: CDMarketData;

    constructor(props: EsotericNormalProps) {
        super(props);
        this.standardPriceDiff = props.standardPriceDiff;
        this.timeElapsedLinearBound = props.timeElapsedLinearBound;
        this.sdevMagic = props.sdevMagic;
        this.cdMarketData = props.cdMarketData;
    }

    private normalMult(priceDiff: number, timeElapsedInHour: number): number {
        // https://www.typescriptlang.org/play/?#code/GYVwdgxgLglg9mABGOAnAtgQwDYFkTZQAUADqjBAKYAiMwwAXMiOgEaWoA0is6lAotkwkAzpQAmASTAAJOCFRMwLdqgCUSlR0QBvAFB7ERxBAQioic5jDjMqcQAVyVWvUQBeRACYADD4DciAD0QYgAgmAAnogkcCIwsABulMxsHIbGpmDmPDB8gsJi4gAyMGCUdgBC8jYeiAB0AGyBIYg+ALQAjBlGWTki4pSJuJgA5hR1XgbGJmYWmHUjUAAW9VgAHkT1Pp3cRJ3tRPvtvAJCohLScgpqiABUufnnRaXlVTXial-3loPDYxQWqErDY7OJEH8YJhYAgerNshZWHUAsFQnxrCZKGAoBxuGQ4KxMKxsNFxAgAOQWCDLayjShwvoWdZ1UjOGh0YDBSxQay2exOCjs+hqIExIRUPjYxA4BCjCEwczkVggGFgBlzZBodB1TqIdqIIhwmb7LlEBYPJarEQAR1QxC8P0t9Qcki+aiNxgeRCdsQA7t7oat+Nx2j64P71u1WNwvLdQkQHRbA-U-WaY273TNM8ZUJQoAokCgMHoAL4GPpwbCUerYOCjIjkgDEzcb5PdFarNbrRCLWDwBGIAFYfNxtl89B3q7X672cPhCERh6PY+2zJWp93Z-2F0uGgAWceTrszrVzgeLkcNRqHted6c90-boeX+oADhv2XXx4fGDPO8vnRfEAA
        //  https://www.desmos.com/calculator/yu4tvrighm

        // const standardPriceDiff = 200; // Any positive number
        // const timeElapsedLinearBound = .6; // 0-1
        // const sdevMagic = 2

        const a = Math.max(.01, (1 - ((1 - timeElapsedInHour) * this.timeElapsedLinearBound))) * this.sdevMagic; // standard deviation
        const b = 0; // mean center, probably don't change
        const x = (priceDiff / this.standardPriceDiff); // placement along distribution

        const norm = 1 - (
            (1 / (a * Math.sqrt(2 * Math.PI)))
            * (Math.pow(Math.E, -Math.pow(x - b, 2) / (2 * Math.pow(a, 2))))
        )
        return norm
    }

    public async run() {
        this.tickWrapper(1000 * 5, 1000 * 2, async () => {

        });
    }

}