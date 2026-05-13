import { describe, expect, it } from 'vitest';
import { calendarBillingPeriod, isoUtc, isValidIanaTimezone } from '../../src/services/tz.js';

describe('timezone helpers', () => {
  it('accepts IANA zones and rejects bogus ones', () => {
    expect(isValidIanaTimezone('America/Mexico_City')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('Not/A/Zone')).toBe(false);
  });

  it('calendar period for MX-May ends at 2026-06-01T05:59:59Z', () => {
    const reference = new Date('2026-05-12T22:20:37Z');
    const { start, end, daysInPeriod } = calendarBillingPeriod(reference, 'America/Mexico_City');
    expect(isoUtc(start)).toBe('2026-05-01T06:00:00Z');
    expect(isoUtc(end)).toBe('2026-06-01T05:59:59Z');
    expect(daysInPeriod).toBe(31);
  });

  it('calendar period for UTC-Apr (30 days)', () => {
    const reference = new Date('2026-04-12T00:00:00Z');
    const { start, end, daysInPeriod } = calendarBillingPeriod(reference, 'UTC');
    expect(isoUtc(start)).toBe('2026-04-01T00:00:00Z');
    expect(isoUtc(end)).toBe('2026-04-30T23:59:59Z');
    expect(daysInPeriod).toBe(30);
  });
});
