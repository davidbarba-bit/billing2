// Timezone helpers. mini-Lago aligns billing periods to the customer's
// `applicable_timezone` (D4), not UTC.

import { DateTime, IANAZone } from 'luxon';

export function isValidIanaTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function applicableTimezone(
  customerTz: string | null | undefined,
  orgTz: string | null | undefined,
): string {
  return customerTz ?? orgTz ?? 'UTC';
}

// Format a Date as the wire-form ISO string Lago uses: `YYYY-MM-DDTHH:MM:SSZ`
// (UTC, no millis, trailing Z). Drops sub-second precision because both the
// Lago Cloud captures and the synthetic fixtures use this shape.
export function isoUtc(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).toFormat("yyyy-LL-dd'T'HH:mm:ss'Z'");
}

// Format a Date as `YYYY-MM-DD` in the given timezone.
export function isoDateIn(date: Date, tz: string): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).setZone(tz).toFormat('yyyy-LL-dd');
}

// Start of the current calendar month in `tz`, returned as UTC Date.
export function startOfMonthUtc(reference: Date, tz: string): Date {
  return DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz).startOf('month').toUTC().toJSDate();
}

// Last instant of the current calendar month in `tz`, inclusive: the second
// before next-month-start. Returned as UTC Date.
export function endOfMonthInclusiveUtc(reference: Date, tz: string): Date {
  const startNext = DateTime.fromJSDate(reference, { zone: 'utc' })
    .setZone(tz)
    .startOf('month')
    .plus({ months: 1 })
    .toUTC();
  return startNext.minus({ seconds: 1 }).toJSDate();
}

// Calendar billing period for `reference` aligned to `tz` (D4 + invariante #9).
export function calendarBillingPeriod(reference: Date, tz: string): {
  start: Date;
  end: Date;
  daysInPeriod: number;
} {
  const start = startOfMonthUtc(reference, tz);
  const end = endOfMonthInclusiveUtc(reference, tz);
  const startDt = DateTime.fromJSDate(start, { zone: 'utc' }).setZone(tz);
  const nextStart = startDt.plus({ months: 1 });
  const daysInPeriod = Math.round(nextStart.diff(startDt, 'days').days);
  return { start, end, daysInPeriod };
}

// Anniversary billing period anchored on the day-of-month of `anchor` (D4).
// Returns the period containing `reference`.
export function anniversaryBillingPeriod(
  anchor: Date,
  reference: Date,
  tz: string,
): { start: Date; end: Date; daysInPeriod: number } {
  const anchorDt = DateTime.fromJSDate(anchor, { zone: 'utc' }).setZone(tz);
  const referenceDt = DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz);
  const day = anchorDt.day;

  let candidate = referenceDt.startOf('day').set({ day });
  if (candidate > referenceDt) {
    candidate = candidate.minus({ months: 1 });
  }
  const start = candidate.startOf('day').set({ day });
  const end = start.plus({ months: 1 }).minus({ seconds: 1 });
  const daysInPeriod = Math.round(start.plus({ months: 1 }).diff(start, 'days').days);
  return {
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
    daysInPeriod,
  };
}

// Number of full days `[start, end)` covers when projected into `tz`.
export function daysBetween(start: Date, end: Date, tz: string): number {
  const startDt = DateTime.fromJSDate(start, { zone: 'utc' }).setZone(tz).startOf('day');
  const endDt = DateTime.fromJSDate(end, { zone: 'utc' }).setZone(tz).startOf('day');
  return Math.max(0, Math.round(endDt.diff(startDt, 'days').days));
}
