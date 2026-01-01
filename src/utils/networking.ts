export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function retryWrapper<T>(func: () => T | Promise<T>, errFunc: (e: unknown) => void, retries = 5, delaySleepMs = 2000): Promise<T> {
    for (let i = 0; i < retries; i++) {
        try {
            const t = await func();
            return t;
        } catch (e) {
            errFunc(e);
            await sleep(delaySleepMs);
            continue;
        }
    }
    throw Error("retry wrapper ran out of retries.");
}