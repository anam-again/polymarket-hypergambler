// ============================================================================
// RegimeMSPEQManager - Manages MSPEQs with per-regime scaling
// ============================================================================

import { MultiSignalPEQ } from '../utils/MultiSignalPEQ.js';
import { RegimeType, PerRegimeScaling, ALL_REGIME_TYPES } from './RegimeTypes.js';

/**
 * RegimeMSPEQManager - Applies per-regime scaling to base MSPEQs.
 *
 * Instead of having completely separate MSPEQ parameters per regime (288 params),
 * this uses shared base MSPEQs with per-regime scaling factors (114 params).
 *
 * Formula: MSPEQ_output = baseMSPEQ.compute(signals) × regimeScaling[currentRegime]
 */
export class RegimeMSPEQManager {
    private baseMSPEQs: Map<string, MultiSignalPEQ>;
    private scalings: PerRegimeScaling;

    constructor(
        baseMSPEQs: Record<string, MultiSignalPEQ>,
        scalings: PerRegimeScaling
    ) {
        this.baseMSPEQs = new Map(Object.entries(baseMSPEQs));
        this.scalings = scalings;
    }

    /**
     * Computes an MSPEQ output with regime-specific scaling.
     *
     * @param mspeqName - Name of the MSPEQ to compute (e.g., 'buyPrice', 'sellPrice')
     * @param signals - Current signal values
     * @param regime - Current market regime
     * @returns Scaled MSPEQ output
     * @throws Error if MSPEQ name is unknown
     */
    compute(mspeqName: string, signals: Record<string, number>, regime: RegimeType): number {
        const baseMSPEQ = this.baseMSPEQs.get(mspeqName);
        if (!baseMSPEQ) {
            throw new Error(`Unknown MSPEQ: ${mspeqName}`);
        }

        const baseOutput = baseMSPEQ.compute(signals);
        const scaling = this.scalings[regime]?.[mspeqName] ?? 1.0;

        return baseOutput * scaling;
    }

    /**
     * Gets all MSPEQ names managed by this instance.
     */
    getMSPEQNames(): string[] {
        return Array.from(this.baseMSPEQs.keys());
    }

    /**
     * Gets the scaling factor for a specific regime and MSPEQ.
     */
    getScaling(regime: RegimeType, mspeqName: string): number {
        return this.scalings[regime]?.[mspeqName] ?? 1.0;
    }

    /**
     * Creates a RegimeMSPEQManager from flat optimization parameters.
     *
     * @param params - Flat parameter record from optimizer
     * @param mspeqNames - Array of MSPEQ names (e.g., ['buyPrice', 'sellPrice', ...])
     * @param signalNames - Array of signal names for each MSPEQ
     * @returns New RegimeMSPEQManager instance
     */
    static fromParams(
        params: Record<string, number>,
        mspeqNames: string[],
        signalNames: string[]
    ): RegimeMSPEQManager {
        // Build base MSPEQs from params
        const baseMSPEQs: Record<string, MultiSignalPEQ> = {};
        for (const name of mspeqNames) {
            baseMSPEQs[name] = MultiSignalPEQ.fromFlatParams(name, params, signalNames);
        }

        // Build per-regime scalings
        const scalings: PerRegimeScaling = {
            [RegimeType.HIGH_VOL_TRENDING]: {},
            [RegimeType.HIGH_VOL_RANGING]: {},
            [RegimeType.LOW_VOL_TRENDING]: {},
            [RegimeType.LOW_VOL_RANGING]: {},
        };

        for (const regime of ALL_REGIME_TYPES) {
            for (const mspeqName of mspeqNames) {
                scalings[regime][mspeqName] = params[`${regime}_${mspeqName}_scale`] ?? 1.0;
            }
        }

        return new RegimeMSPEQManager(baseMSPEQs, scalings);
    }

    /**
     * Returns parameter bounds for per-regime scaling factors.
     *
     * @param mspeqNames - Array of MSPEQ names to generate bounds for
     */
    static getBounds(mspeqNames: string[]): Record<string, { min: number; max: number }> {
        const bounds: Record<string, { min: number; max: number }> = {};

        for (const regime of ALL_REGIME_TYPES) {
            for (const mspeqName of mspeqNames) {
                bounds[`${regime}_${mspeqName}_scale`] = { min: 0.5, max: 2.0 };
            }
        }

        return bounds;
    }
}
