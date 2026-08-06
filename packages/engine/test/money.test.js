import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { InvalidMoneyError, addMoney, moneyFromDecimalString, moneyFromJSON, sumMoney } from '../src/money/money.js';

describe('Money', () => {
  it('rejects negative amounts', () => {
    expect(() => moneyFromJSON('-5')).toThrow(InvalidMoneyError);
  });

  it('rejects constructing Money from a JS number', () => {
    expect(() => moneyFromJSON(5.5)).toThrow(InvalidMoneyError);
  });

  it('parses decimal strings into exact minor units', () => {
    expect(moneyFromDecimalString('500.00')).toBe(50000n);
    expect(moneyFromDecimalString('500')).toBe(50000n);
    expect(moneyFromDecimalString('0.01')).toBe(1n);
  });

  it('sums are exact for arbitrary bigint amounts (no float rounding possible)', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10_000_000_000n })), (amounts) => {
        const expected = amounts.reduce((a, b) => a + b, 0n);
        expect(sumMoney(amounts)).toBe(expected);
      }),
    );
  });

  it('addMoney is associative', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (a, b, c) => {
          expect(addMoney(addMoney(a, b), c)).toBe(addMoney(a, addMoney(b, c)));
        },
      ),
    );
  });
});
