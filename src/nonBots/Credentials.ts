import { ApiKeyCreds, ClobClient, } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";


import dotenv from 'dotenv';

export class Credentials {

    private host!: string;
    private funder!: string;
    private signer!: Wallet;
    private coinbaseApiKeyName!: string;
    private coinbaseApiPrivateKey!: string;

    private creds?: ApiKeyCreds;
    public clobClient?: ClobClient;

    constructor() {
        dotenv.config();

        const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
        const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;

        if (!privateKey) {
            throw new Error("POLYMARKET_PRIVATE_KEY environment variable is required");
        }
        if (!funderAddress) {
            throw new Error("POLYMARKET_FUNDER_ADDRESS environment variable is required");
        }

        const coinbaseApiKeyName = process.env.COINBASE_API_KEY_NAME;
        const coinbaseApiPrivateKey = process.env.COINBASE_API_PRIVATE_KEY;

        if(!coinbaseApiKeyName) {
            throw new Error("COINBASE_API_KEY_NAME environment variable is required");
        }
        if(!coinbaseApiPrivateKey) {
            throw new Error("COINBASE_API_PRIVATE_KEY environment variable is required");
        }

        this.coinbaseApiKeyName = coinbaseApiKeyName;
        this.coinbaseApiPrivateKey = coinbaseApiPrivateKey;

        this.host = 'https://clob.polymarket.com';
        this.funder = funderAddress;

        this.signer = new Wallet(privateKey);

    }

    public async initClobClient(): Promise<ClobClient> {


        // create or Derive isn't working here for some reason
        this.creds = await new ClobClient(this.host, 137, this.signer).deriveApiKey();

        //1: Magic/Email Login
        //2: Browser Wallet(Metamask, Coinbase Wallet, etc)
        //0: EOA (If you don't know what this is you're not using it)

        const signatureType = 1;

        this.clobClient = new ClobClient(this.host, 137, this.signer, this.creds, signatureType, this.funder);

        return this.clobClient;
    }
}