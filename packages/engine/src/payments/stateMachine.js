/** The legal edges of the payment state diagram. Anything not listed here is illegal. */
const LEGAL_TRANSITIONS = {
  created: ['pending', 'failed'],
  pending: ['inflight', 'failed'],
  inflight: ['succeeded', 'failed'],
  succeeded: ['refund_pending'],
  refund_pending: ['refunded'],
  refunded: [],
  failed: [],
};

export function isLegalTransition(from, to) {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Shortest sequence of legal states from `from` to `to`, excluding `from`
 * itself; [] when already there, null when unreachable. Reconciliation uses
 * this to advance a stale payment along real edges — stepping through
 * `inflight` keeps the hold accounting intact instead of teleporting the
 * state cache.
 */
export function legalPath(from, to) {
  if (from === to) return [];
  const previous = new Map();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of LEGAL_TRANSITIONS[current]) {
      if (previous.has(next) || next === from) continue;
      previous.set(next, current);
      if (next === to) {
        const path = [to];
        let step = current;
        while (step !== from) {
          path.unshift(step);
          step = previous.get(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * An event that would cause an illegal transition (stale or premature) is
 * not applied blindly — it's recorded (`applied: false`) and left for
 * reconciliation to resolve. This function never throws; the caller decides
 * what to do with an unapplied event.
 */
export function evaluateTransition(current, requested) {
  if (isLegalTransition(current, requested)) {
    return { applied: true };
  }
  if (current === requested) {
    return { applied: false, reason: 'stale: payment already in requested state' };
  }
  return { applied: false, reason: `illegal transition ${current} -> ${requested}` };
}
