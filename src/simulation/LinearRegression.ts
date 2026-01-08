// ============================================================================
// Linear Regression for Parameter Optimization
// ============================================================================

export interface RegressionResult {
    coefficients: Map<string, number>;
    intercept: number;
    rSquared: number;
    predictions: number[];
    optimalParams: Record<string, number>;
    predictedOptimalPnl: number;
}

export interface FeatureImportance {
    feature: string;
    coefficient: number;
    normalizedCoefficient: number;
    impact: 'positive' | 'negative';
}

/**
 * Simple multivariate linear regression implementation.
 * Uses ordinary least squares (OLS) via normal equation.
 */
export class LinearRegression {
    private featureNames: string[] = [];
    private coefficients: number[] = [];
    private intercept: number = 0;
    private featureMeans: number[] = [];
    private featureStds: number[] = [];
    private targetMean: number = 0;
    private targetStd: number = 1;

    /**
     * Fits the linear regression model to the data.
     * @param features Array of feature objects (parameter sets)
     * @param targets Array of target values (PnL)
     */
    public fit(features: Record<string, number>[], targets: number[]): void {
        if (features.length === 0 || features.length !== targets.length) {
            throw new Error('Features and targets must have the same non-zero length');
        }

        // Extract feature names from first sample
        this.featureNames = Object.keys(features[0]).filter(key =>
            typeof features[0][key] === 'number'
        );

        const n = features.length;
        const m = this.featureNames.length;

        // Convert to matrix format and normalize
        const X: number[][] = [];
        for (const feature of features) {
            const row: number[] = [];
            for (const name of this.featureNames) {
                row.push(feature[name] ?? 0);
            }
            X.push(row);
        }

        // Calculate means and stds for normalization
        this.featureMeans = new Array(m).fill(0);
        this.featureStds = new Array(m).fill(0);

        for (let j = 0; j < m; j++) {
            let sum = 0;
            for (let i = 0; i < n; i++) {
                sum += X[i][j];
            }
            this.featureMeans[j] = sum / n;

            let sumSq = 0;
            for (let i = 0; i < n; i++) {
                sumSq += Math.pow(X[i][j] - this.featureMeans[j], 2);
            }
            this.featureStds[j] = Math.sqrt(sumSq / n) || 1;
        }

        // Normalize features
        const XNorm: number[][] = [];
        for (let i = 0; i < n; i++) {
            const row: number[] = [1]; // Bias term
            for (let j = 0; j < m; j++) {
                row.push((X[i][j] - this.featureMeans[j]) / this.featureStds[j]);
            }
            XNorm.push(row);
        }

        // Normalize targets
        this.targetMean = targets.reduce((a, b) => a + b, 0) / n;
        const targetVariance = targets.reduce((sum, t) => sum + Math.pow(t - this.targetMean, 2), 0) / n;
        this.targetStd = Math.sqrt(targetVariance) || 1;

        const yNorm = targets.map(t => (t - this.targetMean) / this.targetStd);

        // Solve using normal equation: (X^T * X)^-1 * X^T * y
        const XtX = this.matrixMultiply(this.transpose(XNorm), XNorm);
        const XtY = this.matrixVectorMultiply(this.transpose(XNorm), yNorm);

        // Add small regularization for numerical stability
        for (let i = 0; i < XtX.length; i++) {
            XtX[i][i] += 0.001;
        }

        const XtXInv = this.invertMatrix(XtX);
        const beta = this.matrixVectorMultiply(XtXInv, XtY);

        // Extract coefficients (denormalize)
        this.intercept = beta[0] * this.targetStd + this.targetMean;
        this.coefficients = [];

        for (let j = 0; j < m; j++) {
            const coef = (beta[j + 1] * this.targetStd) / this.featureStds[j];
            this.coefficients.push(coef);
            this.intercept -= coef * this.featureMeans[j];
        }
    }

    /**
     * Predicts target values for given features.
     */
    public predict(features: Record<string, number>[]): number[] {
        return features.map(f => this.predictSingle(f));
    }

    /**
     * Predicts a single target value.
     */
    public predictSingle(features: Record<string, number>): number {
        let prediction = this.intercept;
        for (let j = 0; j < this.featureNames.length; j++) {
            const value = features[this.featureNames[j]] ?? 0;
            prediction += this.coefficients[j] * value;
        }
        return prediction;
    }

    /**
     * Calculates R-squared score.
     */
    public rSquared(features: Record<string, number>[], targets: number[]): number {
        const predictions = this.predict(features);
        const mean = targets.reduce((a, b) => a + b, 0) / targets.length;

        let ssRes = 0;
        let ssTot = 0;

        for (let i = 0; i < targets.length; i++) {
            ssRes += Math.pow(targets[i] - predictions[i], 2);
            ssTot += Math.pow(targets[i] - mean, 2);
        }

        return ssTot > 0 ? 1 - (ssRes / ssTot) : 0;
    }

    /**
     * Gets feature importance (coefficients).
     */
    public getFeatureImportance(): FeatureImportance[] {
        const maxCoef = Math.max(...this.coefficients.map(Math.abs)) || 1;

        return this.featureNames.map((name, i) => ({
            feature: name,
            coefficient: this.coefficients[i],
            normalizedCoefficient: this.coefficients[i] / maxCoef,
            impact: (this.coefficients[i] >= 0 ? 'positive' : 'negative') as 'positive' | 'negative',
        })).sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));
    }

    /**
     * Finds optimal parameters within given bounds using gradient ascent.
     */
    public findOptimalParams(
        bounds: Record<string, { min: number; max: number }>
    ): { params: Record<string, number>; predictedPnl: number } {
        const params: Record<string, number> = {};

        // For linear regression, optimal is at boundary
        // Move in direction of positive coefficient
        for (let j = 0; j < this.featureNames.length; j++) {
            const name = this.featureNames[j];
            const bound = bounds[name];

            if (bound) {
                // If coefficient is positive, maximize the feature; if negative, minimize
                params[name] = this.coefficients[j] >= 0 ? bound.max : bound.min;
            } else {
                // Use mean if no bounds provided
                params[name] = this.featureMeans[j];
            }
        }

        return {
            params,
            predictedPnl: this.predictSingle(params),
        };
    }

    /**
     * Gets the model coefficients.
     */
    public getCoefficients(): Map<string, number> {
        const result = new Map<string, number>();
        result.set('intercept', this.intercept);
        for (let i = 0; i < this.featureNames.length; i++) {
            result.set(this.featureNames[i], this.coefficients[i]);
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // Matrix Operations
    // -------------------------------------------------------------------------

    private transpose(matrix: number[][]): number[][] {
        const rows = matrix.length;
        const cols = matrix[0].length;
        const result: number[][] = [];

        for (let j = 0; j < cols; j++) {
            result[j] = [];
            for (let i = 0; i < rows; i++) {
                result[j][i] = matrix[i][j];
            }
        }
        return result;
    }

    private matrixMultiply(a: number[][], b: number[][]): number[][] {
        const rowsA = a.length;
        const colsA = a[0].length;
        const colsB = b[0].length;
        const result: number[][] = [];

        for (let i = 0; i < rowsA; i++) {
            result[i] = [];
            for (let j = 0; j < colsB; j++) {
                let sum = 0;
                for (let k = 0; k < colsA; k++) {
                    sum += a[i][k] * b[k][j];
                }
                result[i][j] = sum;
            }
        }
        return result;
    }

    private matrixVectorMultiply(matrix: number[][], vector: number[]): number[] {
        return matrix.map(row =>
            row.reduce((sum, val, i) => sum + val * vector[i], 0)
        );
    }

    private invertMatrix(matrix: number[][]): number[][] {
        const n = matrix.length;
        const augmented: number[][] = matrix.map((row, i) => [
            ...row,
            ...Array(n).fill(0).map((_, j) => i === j ? 1 : 0)
        ]);

        // Gaussian elimination with partial pivoting
        for (let col = 0; col < n; col++) {
            // Find pivot
            let maxRow = col;
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(augmented[row][col]) > Math.abs(augmented[maxRow][col])) {
                    maxRow = row;
                }
            }
            [augmented[col], augmented[maxRow]] = [augmented[maxRow], augmented[col]];

            const pivot = augmented[col][col];
            if (Math.abs(pivot) < 1e-10) {
                // Matrix is singular, return identity-ish
                continue;
            }

            // Scale pivot row
            for (let j = 0; j < 2 * n; j++) {
                augmented[col][j] /= pivot;
            }

            // Eliminate column
            for (let row = 0; row < n; row++) {
                if (row !== col) {
                    const factor = augmented[row][col];
                    for (let j = 0; j < 2 * n; j++) {
                        augmented[row][j] -= factor * augmented[col][j];
                    }
                }
            }
        }

        // Extract inverse
        return augmented.map(row => row.slice(n));
    }
}

/**
 * Analyzes simulation results using linear regression.
 */
export function analyzeWithRegression(
    results: { params: Record<string, unknown>; totalPnl: number }[]
): RegressionResult | null {
    if (results.length < 3) {
        console.log('Not enough data points for regression analysis (need at least 3)');
        return null;
    }

    // Convert params to numeric features
    const features: Record<string, number>[] = results.map(r => {
        const numericParams: Record<string, number> = {};
        for (const [key, value] of Object.entries(r.params)) {
            if (typeof value === 'number') {
                numericParams[key] = value;
            }
        }
        return numericParams;
    });

    const targets = results.map(r => r.totalPnl);

    // Fit regression
    const regression = new LinearRegression();
    regression.fit(features, targets);

    // Calculate bounds from the data
    const bounds: Record<string, { min: number; max: number }> = {};
    const featureNames = Object.keys(features[0]);

    for (const name of featureNames) {
        const values = features.map(f => f[name]);
        bounds[name] = {
            min: Math.min(...values),
            max: Math.max(...values),
        };
    }

    // Find optimal
    const optimal = regression.findOptimalParams(bounds);

    return {
        coefficients: regression.getCoefficients(),
        intercept: regression.getCoefficients().get('intercept') ?? 0,
        rSquared: regression.rSquared(features, targets),
        predictions: regression.predict(features),
        optimalParams: optimal.params,
        predictedOptimalPnl: optimal.predictedPnl,
    };
}
