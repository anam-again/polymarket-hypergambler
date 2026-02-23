import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExitModel } from '../src/ml/ExitModel.js';

const cloneWeights = (model: ExitModel): number[] => ([...(model as any).weights]);
const setTrainingSamples = (model: ExitModel, count: number) => {
    (model as any).trainingSamples = count;
};
const setConstantWeightsAndBias = (model: ExitModel, weightValue: number, biasValue: number) => {
    const weightCount = (model as any).weights.length;
    (model as any).weights = Array(weightCount).fill(weightValue);
    (model as any).bias = biasValue;
};

describe('ExitModel degeneracy detection', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('does not reset when insufficient samples are available', () => {
        const model = new ExitModel();
        const originalWeights = cloneWeights(model);
        setTrainingSamples(model, 10);

        const wasReset = model.checkAndResetIfDegenerate();

        expect(wasReset).toBe(false);
        expect((model as any).trainingSamples).toBe(10);
        expect((model as any).weights).toEqual(originalWeights);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('resets when fill probabilities are stuck near zero', () => {
        const model = new ExitModel();
        setTrainingSamples(model, 100);
        setConstantWeightsAndBias(model, 0, -10); // force sigmoid to ~0

        const wasReset = model.checkAndResetIfDegenerate();

        expect(wasReset).toBe(true);
        expect((model as any).trainingSamples).toBe(0);
        expect((model as any).bias).toBe(0);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('Degenerate state detected');
    });

    it('resets when fill probabilities are stuck near one', () => {
        const model = new ExitModel();
        setTrainingSamples(model, 120);
        setConstantWeightsAndBias(model, 0, 10); // force sigmoid to ~1

        const wasReset = model.checkAndResetIfDegenerate();

        expect(wasReset).toBe(true);
        expect((model as any).trainingSamples).toBe(0);
        expect((model as any).bias).toBe(0);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('Degenerate state detected');
    });
});
