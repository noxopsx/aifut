// Núcleo matemático compartido por el motor y el backtest.
// No depende de datos ni del DOM: se puede ejecutar en el navegador y en Node.

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const FACT = [1];
for (let i = 1; i <= 24; i += 1) FACT[i] = FACT[i - 1] * i;

export function poissonPmf(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k];
}

export function poissonCdf(k, lambda) {
  let total = 0;
  for (let i = 0; i <= Math.floor(k); i += 1) total += poissonPmf(i, lambda);
  return clamp(total, 0, 1);
}

export function poissonOver(line, lambda) {
  return clamp(1 - poissonCdf(Math.floor(line), lambda), 0, 1);
}

export function dixonTau(i, j, home, away, rho) {
  if (i === 0 && j === 0) return Math.max(1e-6, 1 - home * away * rho);
  if (i === 0 && j === 1) return Math.max(1e-6, 1 + home * rho);
  if (i === 1 && j === 0) return Math.max(1e-6, 1 + away * rho);
  if (i === 1 && j === 1) return Math.max(1e-6, 1 - rho);
  return 1;
}

export function buildMatrix(home, away, rho = -0.055, max = 10) {
  const matrix = [];
  let total = 0;
  for (let i = 0; i <= max; i += 1) {
    matrix[i] = [];
    for (let j = 0; j <= max; j += 1) {
      const p = poissonPmf(i, home) * poissonPmf(j, away) * dixonTau(i, j, home, away, rho);
      matrix[i][j] = p;
      total += p;
    }
  }
  const safeTotal = total > 0 ? total : 1;
  for (let i = 0; i <= max; i += 1) {
    for (let j = 0; j <= max; j += 1) matrix[i][j] /= safeTotal;
  }
  return matrix;
}

export function summarizeMatrix(matrix) {
  const probs = { home: 0, draw: 0, away: 0 };
  const totals = [0, 0, 0, 0, 0, 0];
  const scores = [];
  let btts = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i].length; j += 1) {
      const p = matrix[i][j];
      if (i > j) probs.home += p;
      else if (i === j) probs.draw += p;
      else probs.away += p;
      totals[Math.min(i + j, 5)] += p;
      if (i > 0 && j > 0) btts += p;
      scores.push({ home: i, away: j, p });
    }
  }
  scores.sort((a, b) => b.p - a.p);
  return { probs, totals, btts, scores };
}

export function matrixOver(matrix, line) {
  let p = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i].length; j += 1) {
      if (i + j > line) p += matrix[i][j];
    }
  }
  return clamp(p, 0, 1);
}

export function matrixUnder(matrix, line) {
  return clamp(1 - matrixOver(matrix, line), 0, 1);
}

// Reduce la matriz a una vista 7×7 (0-6 goles) y agrupa la cola.
export function sliceMatrix(matrix, size = 7) {
  const cells = [];
  let shown = 0;
  let max = 0;
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      const p = matrix[i]?.[j] ?? 0;
      cells.push({ home: i, away: j, p });
      shown += p;
      if (p > max) max = p;
    }
  }
  return { cells, shown, rest: clamp(1 - shown, 0, 1), max, size };
}

// Probabilidad conjunta de varias condiciones sobre la matriz de marcadores.
export function matrixJoint(matrix, conditions) {
  if (!conditions.length) return 1;
  let p = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i].length; j += 1) {
      if (conditions.every((condition) => condition(i, j))) p += matrix[i][j];
    }
  }
  return clamp(p, 0, 1);
}
