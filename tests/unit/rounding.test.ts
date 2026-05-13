import { describe, expect, it } from 'vitest';
import { amountStringToCents, applyFraction, bankersRound, fraction4, unitsForUsage } from '../../src/services/rounding.js';

describe('bankersRound', () => {
  it('rounds half to even', () => {
    expect(bankersRound(0.5)).toBe(0);
    expect(bankersRound(1.5)).toBe(2);
    expect(bankersRound(2.5)).toBe(2);
    expect(bankersRound(3.5)).toBe(4);
    expect(bankersRound(-0.5)).toBe(0);
  });
  it('rounds non-half normally', () => {
    expect(bankersRound(0.4)).toBe(0);
    expect(bankersRound(0.6)).toBe(1);
  });
});

describe('fraction4', () => {
  it('produces strings of exactly 4 decimal digits', () => {
    expect(fraction4(1)).toBe('1.0000');
    expect(fraction4(0)).toBe('0.0000');
    expect(fraction4(0.5)).toBe('0.5000');
    expect(fraction4(0.61290322)).toBe('0.6129');
    expect(fraction4(0.96774193)).toBe('0.9677');
    expect(fraction4(2.5806)).toBe('2.5806');
  });
});

describe('amountStringToCents', () => {
  it('converts decimal strings to integer cents', () => {
    expect(amountStringToCents('450.00')).toBe(45000);
    expect(amountStringToCents('1200.00')).toBe(120000);
    expect(amountStringToCents('0')).toBe(0);
    expect(amountStringToCents('0.5')).toBe(50);
  });
});

describe('applyFraction', () => {
  it('multiplies fraction × unit_amount with banker rounding', () => {
    expect(applyFraction('1.0000', 45000)).toBe(45000);
    // Exactly half → banker's: 27580.5 → 27580 (even).
    expect(applyFraction('0.6129', 45000)).toBe(27580);
    // 0.9677 × 45000 = 43546.5 → banker's → 43546 (even).
    expect(applyFraction('0.9677', 45000)).toBe(43546);
  });
});

describe('unitsForUsage', () => {
  it('keeps trailing .0 for integers and exposes float precision otherwise', () => {
    expect(unitsForUsage(0)).toBe('0.0');
    expect(unitsForUsage(1)).toBe('1.0');
    expect(unitsForUsage(0.5483870967741935)).toBe('0.5483870967741935');
  });
});
