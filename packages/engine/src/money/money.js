/**
 * Money is always an integer count of minor units (paise/cents), never a
 * float — represented as a JS bigint. Nothing downstream should touch
 * `number` for amounts.
 */

export class InvalidMoneyError extends Error {}

export function money(minorUnits) {
  if (minorUnits < 0n) {
    throw new InvalidMoneyError(`money amount cannot be negative: ${minorUnits}`);
  }
  return minorUnits;
}

/** Parses a decimal-major-unit string ("500.00") into minor units, for input boundaries only. */
export function moneyFromDecimalString(input, minorUnitsPerMajor = 100n) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) {
    throw new InvalidMoneyError(`not a valid decimal money string: ${input}`);
  }
  const [, whole = '0', fraction = ''] = match;
  const paddedFraction = fraction.padEnd(2, '0');
  const minor = BigInt(whole) * minorUnitsPerMajor + BigInt(paddedFraction || '0');
  return money(minor);
}

export function addMoney(a, b) {
  return money(a + b);
}

export function subtractMoney(a, b) {
  const result = a - b;
  if (result < 0n) {
    throw new InvalidMoneyError(`money subtraction went negative: ${a} - ${b}`);
  }
  return result;
}

export function sumMoney(amounts) {
  return amounts.reduce((total, amount) => addMoney(total, amount), 0n);
}

export function moneyEquals(a, b) {
  return a === b;
}

export function moneyToJSON(amount) {
  return amount.toString();
}

export function moneyFromJSON(value) {
  if (typeof value === 'bigint') return money(value);
  if (typeof value === 'number') {
    throw new InvalidMoneyError('refusing to construct Money from a JS number — pass a string or bigint');
  }
  if (!/^\d+$/.test(value)) {
    throw new InvalidMoneyError(`not a valid integer minor-units string: ${value}`);
  }
  return money(BigInt(value));
}
