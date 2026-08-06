const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000';

async function request(path, init) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

export const api = {
  overview: () => request('/overview'),
  trialBalance: () => request('/ledger/trial-balance'),
  transactions: () => request('/ledger/transactions'),
  payments: () => request('/payments'),
  payment: (id) => request(`/payments/${id}`),
  breaks: (filter = {}) => {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.driftClass) params.set('drift_class', filter.driftClass);
    const qs = params.toString();
    return request(`/reconciliation/breaks${qs ? `?${qs}` : ''}`);
  },
  resolveBreak: (id, resolvedBy, action) =>
    request(`/reconciliation/breaks/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolvedBy, action }),
    }),
  ignoreBreak: (id, resolvedBy) =>
    request(`/reconciliation/breaks/${id}/ignore`, { method: 'POST', body: JSON.stringify({ resolvedBy }) }),
  runReconciliation: (windowMinutes = 60) =>
    request('/reconciliation/run', {
      method: 'POST',
      body: JSON.stringify({ windowMinutes }),
    }),
  reconRuns: () => request('/reconciliation/runs'),
  chaosScenario: (scenario) =>
    request('/chaos/scenario', { method: 'POST', body: JSON.stringify({ scenario }) }),
  chaosMatrix: () => request('/chaos/matrix', { method: 'POST' }),
  chaosScoring: (rounds = 2) =>
    request('/chaos/scoring', {
      method: 'POST',
      body: JSON.stringify({ rounds }),
    }),
  exportUrl: (dataset) => `${API_BASE}/analytics/export?dataset=${dataset}`,
};

export function formatMoney(minorUnits, currency = 'INR') {
  const value = BigInt(minorUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const major = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minor = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${currency} ${major}.${minor}`;
}
