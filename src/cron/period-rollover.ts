// Period roll-over cron (D9 + invariant #15).
//
// The cron does ONE thing: move subscriptions whose
// `current_billing_period_ending_at` is in the past to the next period. It
// does NOT emit invoices — that's strictly a `POST /invoices` operation.

import type { PrismaClient, Subscription } from '@prisma/client';
import { applicableTimezone, anniversaryBillingPeriod, calendarBillingPeriod } from '../services/tz.js';

export async function runPeriodRollover(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const subs = await prisma.subscription.findMany({
    where: {
      status: 'active',
      currentBillingPeriodEndingAt: { lte: now },
    },
    include: { customer: true },
  });
  let updated = 0;
  for (const sub of subs) {
    const org = await prisma.organization.findUnique({ where: { id: sub.organizationId } });
    if (!org) continue;
    const tz = applicableTimezone(sub.customer.timezone, org.timezone);
    const period = sub.billingTime === 'calendar'
      ? calendarBillingPeriod(now, tz)
      : anniversaryBillingPeriod(sub.subscriptionAt, now, tz);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        currentBillingPeriodStartedAt: period.start,
        currentBillingPeriodEndingAt: period.end,
      },
    });
    updated += 1;
  }
  return updated;
}

// Activates pending subscriptions whose subscription_at has now passed.
export async function activatePendingSubscriptions(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const subs = await prisma.subscription.findMany({
    where: { status: 'pending', subscriptionAt: { lte: now } },
    include: { customer: true },
  });
  let activated = 0;
  for (const sub of subs) {
    const org = await prisma.organization.findUnique({ where: { id: sub.organizationId } });
    if (!org) continue;
    const tz = applicableTimezone(sub.customer.timezone, org.timezone);
    const period = sub.billingTime === 'calendar'
      ? calendarBillingPeriod(now, tz)
      : anniversaryBillingPeriod(sub.subscriptionAt, now, tz);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'active',
        startedAt: sub.subscriptionAt,
        currentBillingPeriodStartedAt: sub.subscriptionAt,
        currentBillingPeriodEndingAt: period.end,
      },
    });
    activated += 1;
  }
  return activated;
}

export type RollOverSummary = { activated: number; rolledOver: number };

export async function tickRollOver(prisma: PrismaClient, now: Date = new Date()): Promise<RollOverSummary> {
  const activated = await activatePendingSubscriptions(prisma, now);
  const rolledOver = await runPeriodRollover(prisma, now);
  return { activated, rolledOver };
}

// Helper type stub so `noUnusedLocals` is happy when the function is imported
// elsewhere but the return type isn't.
export type _Unused = Subscription;
