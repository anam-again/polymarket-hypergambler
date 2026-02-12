/**
 * Matrix Utilities for CMA-ES
 *
 * Provides essential matrix operations including eigendecomposition,
 * matrix multiplication, and Cholesky decomposition.
 *
 * Note: This is a lightweight implementation optimized for the dimensions
 * typically encountered in optimization (10-100 dimensions). For very
 * high-dimensional problems, consider using a dedicated linear algebra library.
 */

// ============================================================================
// Types
// ============================================================================

export type Matrix = number[][];
export type Vector = number[];

// ============================================================================
// Vector Operations
// ============================================================================

/**
 * Create a zero vector of given length.
 */
export function zeros(n: number): Vector {
    return new Array(n).fill(0);
}

/**
 * Create a vector filled with ones.
 */
export function ones(n: number): Vector {
    return new Array(n).fill(1);
}

/**
 * Vector addition: a + b
 */
export function vectorAdd(a: Vector, b: Vector): Vector {
    return a.map((v, i) => v + b[i]);
}

/**
 * Vector subtraction: a - b
 */
export function vectorSub(a: Vector, b: Vector): Vector {
    return a.map((v, i) => v - b[i]);
}

/**
 * Scalar multiplication: c * v
 */
export function vectorScale(v: Vector, c: number): Vector {
    return v.map(x => x * c);
}

/**
 * Element-wise multiplication: a .* b
 */
export function vectorMul(a: Vector, b: Vector): Vector {
    return a.map((v, i) => v * b[i]);
}

/**
 * Dot product: a · b
 */
export function dot(a: Vector, b: Vector): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

/**
 * Euclidean norm: ||v||
 */
export function norm(v: Vector): number {
    return Math.sqrt(dot(v, v));
}

/**
 * Outer product: a ⊗ b -> matrix
 */
export function outerProduct(a: Vector, b: Vector): Matrix {
    const n = a.length;
    const m = b.length;
    const result: Matrix = [];

    for (let i = 0; i < n; i++) {
        result[i] = [];
        for (let j = 0; j < m; j++) {
            result[i][j] = a[i] * b[j];
        }
    }

    return result;
}

// ============================================================================
// Matrix Operations
// ============================================================================

/**
 * Create an n×n identity matrix.
 */
export function identity(n: number): Matrix {
    const result: Matrix = [];
    for (let i = 0; i < n; i++) {
        result[i] = new Array(n).fill(0);
        result[i][i] = 1;
    }
    return result;
}

/**
 * Create an n×m zero matrix.
 */
export function zeroMatrix(n: number, m: number): Matrix {
    const result: Matrix = [];
    for (let i = 0; i < n; i++) {
        result[i] = new Array(m).fill(0);
    }
    return result;
}

/**
 * Matrix transpose: A^T
 */
export function transpose(A: Matrix): Matrix {
    const n = A.length;
    const m = A[0].length;
    const result: Matrix = [];

    for (let j = 0; j < m; j++) {
        result[j] = [];
        for (let i = 0; i < n; i++) {
            result[j][i] = A[i][j];
        }
    }

    return result;
}

/**
 * Matrix addition: A + B
 */
export function matrixAdd(A: Matrix, B: Matrix): Matrix {
    const n = A.length;
    const m = A[0].length;
    const result: Matrix = [];

    for (let i = 0; i < n; i++) {
        result[i] = [];
        for (let j = 0; j < m; j++) {
            result[i][j] = A[i][j] + B[i][j];
        }
    }

    return result;
}

/**
 * Matrix scalar multiplication: c * A
 */
export function matrixScale(A: Matrix, c: number): Matrix {
    return A.map(row => row.map(v => v * c));
}

/**
 * Matrix-vector multiplication: A * v
 */
export function matrixVectorMul(A: Matrix, v: Vector): Vector {
    const n = A.length;
    const result: Vector = [];

    for (let i = 0; i < n; i++) {
        result[i] = dot(A[i], v);
    }

    return result;
}

/**
 * Matrix-matrix multiplication: A * B
 */
export function matrixMul(A: Matrix, B: Matrix): Matrix {
    const n = A.length;
    const m = B[0].length;
    const k = B.length;
    const result: Matrix = [];

    for (let i = 0; i < n; i++) {
        result[i] = [];
        for (let j = 0; j < m; j++) {
            let sum = 0;
            for (let l = 0; l < k; l++) {
                sum += A[i][l] * B[l][j];
            }
            result[i][j] = sum;
        }
    }

    return result;
}

/**
 * Deep copy a matrix.
 */
export function copyMatrix(A: Matrix): Matrix {
    return A.map(row => [...row]);
}

// ============================================================================
// Eigendecomposition (Symmetric matrices only)
// ============================================================================

/**
 * Eigendecomposition of a symmetric matrix using Jacobi iterations.
 *
 * Returns { eigenvalues, eigenvectors } where:
 * - eigenvalues is a vector of eigenvalues in descending order
 * - eigenvectors is a matrix where column i is the eigenvector for eigenvalue i
 *
 * A = V * diag(eigenvalues) * V^T
 */
export function eigenDecomposition(
    A: Matrix,
    maxIterations: number = 100,
    tolerance: number = 1e-10
): { eigenvalues: Vector; eigenvectors: Matrix } {
    const n = A.length;

    // Work on a copy
    const S = copyMatrix(A);
    const V = identity(n);

    for (let iter = 0; iter < maxIterations; iter++) {
        // Find largest off-diagonal element
        let maxVal = 0;
        let p = 0;
        let q = 1;

        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const absVal = Math.abs(S[i][j]);
                if (absVal > maxVal) {
                    maxVal = absVal;
                    p = i;
                    q = j;
                }
            }
        }

        // Check convergence
        if (maxVal < tolerance) {
            break;
        }

        // Compute rotation angle
        const theta = (S[q][q] - S[p][p]) / (2 * S[p][q]);
        const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        // Apply rotation to S (Jacobi rotation)
        const Spp = S[p][p];
        const Sqq = S[q][q];
        const Spq = S[p][q];

        S[p][p] = c * c * Spp - 2 * s * c * Spq + s * s * Sqq;
        S[q][q] = s * s * Spp + 2 * s * c * Spq + c * c * Sqq;
        S[p][q] = 0;
        S[q][p] = 0;

        for (let i = 0; i < n; i++) {
            if (i !== p && i !== q) {
                const Sip = S[i][p];
                const Siq = S[i][q];
                S[i][p] = c * Sip - s * Siq;
                S[p][i] = S[i][p];
                S[i][q] = s * Sip + c * Siq;
                S[q][i] = S[i][q];
            }
        }

        // Apply rotation to V
        for (let i = 0; i < n; i++) {
            const Vip = V[i][p];
            const Viq = V[i][q];
            V[i][p] = c * Vip - s * Viq;
            V[i][q] = s * Vip + c * Viq;
        }
    }

    // Extract eigenvalues (diagonal of S)
    const eigenvalues: Vector = [];
    for (let i = 0; i < n; i++) {
        eigenvalues.push(S[i][i]);
    }

    // Sort by descending eigenvalue
    const indices = eigenvalues.map((_, i) => i);
    indices.sort((a, b) => eigenvalues[b] - eigenvalues[a]);

    const sortedEigenvalues = indices.map(i => eigenvalues[i]);
    const sortedEigenvectors: Matrix = [];

    for (let i = 0; i < n; i++) {
        sortedEigenvectors[i] = [];
        for (let j = 0; j < n; j++) {
            sortedEigenvectors[i][j] = V[i][indices[j]];
        }
    }

    return { eigenvalues: sortedEigenvalues, eigenvectors: sortedEigenvectors };
}

/**
 * Compute A^(1/2) for a positive definite symmetric matrix A.
 * Uses eigendecomposition: A^(1/2) = V * diag(sqrt(λ)) * V^T
 */
export function matrixSqrt(A: Matrix): Matrix {
    const { eigenvalues, eigenvectors } = eigenDecomposition(A);
    const n = eigenvalues.length;

    // D^(1/2)
    const sqrtD = zeroMatrix(n, n);
    for (let i = 0; i < n; i++) {
        sqrtD[i][i] = Math.sqrt(Math.max(0, eigenvalues[i]));
    }

    // V * D^(1/2) * V^T
    const VDsqrt = matrixMul(eigenvectors, sqrtD);
    return matrixMul(VDsqrt, transpose(eigenvectors));
}

/**
 * Compute A^(-1/2) for a positive definite symmetric matrix A.
 */
export function matrixInvSqrt(A: Matrix): Matrix {
    const { eigenvalues, eigenvectors } = eigenDecomposition(A);
    const n = eigenvalues.length;

    // D^(-1/2)
    const invSqrtD = zeroMatrix(n, n);
    for (let i = 0; i < n; i++) {
        if (eigenvalues[i] > 1e-10) {
            invSqrtD[i][i] = 1 / Math.sqrt(eigenvalues[i]);
        }
    }

    // V * D^(-1/2) * V^T
    const VDinvSqrt = matrixMul(eigenvectors, invSqrtD);
    return matrixMul(VDinvSqrt, transpose(eigenvectors));
}

// ============================================================================
// Cholesky Decomposition
// ============================================================================

/**
 * Cholesky decomposition of a positive definite matrix A.
 * Returns lower triangular L such that A = L * L^T.
 * Returns null if matrix is not positive definite.
 */
export function choleskyDecomposition(A: Matrix): Matrix | null {
    const n = A.length;
    const L = zeroMatrix(n, n);

    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = 0;

            if (i === j) {
                // Diagonal elements
                for (let k = 0; k < j; k++) {
                    sum += L[j][k] * L[j][k];
                }
                const val = A[i][i] - sum;
                if (val <= 0) {
                    // Not positive definite
                    return null;
                }
                L[i][j] = Math.sqrt(val);
            } else {
                // Off-diagonal elements
                for (let k = 0; k < j; k++) {
                    sum += L[i][k] * L[j][k];
                }
                L[i][j] = (A[i][j] - sum) / L[j][j];
            }
        }
    }

    return L;
}

// ============================================================================
// Random Number Generation
// ============================================================================

/**
 * Generate a sample from standard normal distribution using Box-Muller.
 */
export function randn(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Generate a vector of n standard normal samples.
 */
export function randnVector(n: number): Vector {
    const v: Vector = [];
    for (let i = 0; i < n; i++) {
        v.push(randn());
    }
    return v;
}

/**
 * Sample from multivariate normal N(mean, covariance).
 * Uses Cholesky decomposition: x = mean + L * z where L*L^T = covariance
 */
export function sampleMultivariateNormal(
    mean: Vector,
    covariance: Matrix
): Vector {
    const L = choleskyDecomposition(covariance);
    if (L === null) {
        // Fall back to eigendecomposition for non-positive-definite matrices
        const sqrtCov = matrixSqrt(covariance);
        const z = randnVector(mean.length);
        return vectorAdd(mean, matrixVectorMul(sqrtCov, z));
    }

    const z = randnVector(mean.length);
    return vectorAdd(mean, matrixVectorMul(L, z));
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute the trace of a matrix.
 */
export function trace(A: Matrix): number {
    let sum = 0;
    for (let i = 0; i < A.length; i++) {
        sum += A[i][i];
    }
    return sum;
}

/**
 * Create a diagonal matrix from a vector.
 */
export function diag(v: Vector): Matrix {
    const n = v.length;
    const result = zeroMatrix(n, n);
    for (let i = 0; i < n; i++) {
        result[i][i] = v[i];
    }
    return result;
}

/**
 * Check if a matrix is symmetric within tolerance.
 */
export function isSymmetric(A: Matrix, tolerance: number = 1e-10): boolean {
    const n = A.length;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (Math.abs(A[i][j] - A[j][i]) > tolerance) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Force matrix symmetry by averaging A and A^T.
 */
export function makeSymmetric(A: Matrix): Matrix {
    const n = A.length;
    const result = copyMatrix(A);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const avg = (A[i][j] + A[j][i]) / 2;
            result[i][j] = avg;
            result[j][i] = avg;
        }
    }
    return result;
}
