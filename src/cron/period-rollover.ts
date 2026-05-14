// Period roll-over cron (v3: operates on Customer, not Service).
//
// Activates pending customers whose subscription_at has passed, and rolls
// active customers forward when their period ends.
// Does NOT emit invoices — that's caller-driven via POST /api/v1/invoices.

import type { PrismaClient } from '@prisma/client';
import { applicableTimezone } from '../services/tz.js';
import { billingPeriodFor } from '../services/billing-engine.js';

export async function runPeriodRollover(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const customers = await prisma.customer.findMany({
    where: { status: 'active', currentBillingPeriodEndingAt: { lte: now } },
    include: { organization: true },
  });
  let count = 0;
  for (const c of customers) {
    const tz = applicableTimezone(c.timezone, c.organization.timezone);
    const period = billingPeriodFor(c, tz, now);
    await prisma.customer.update({
      where: { id: c.id },
      data: {
        currentBillingPeriodStartedAt: period.start,
        currentBillingPeriodEndingAt: period.end,
      },
    });
    count += 1;
  }
  return count;
}

export async function activatePendingCustomers(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const customers = await prisma.customer.findMany({
    where: { status: 'pending', subscriptionAt: { lte: now } },
    include: { organization: true },
  });
  let count = 0;
  for (const c of customers) {
    const tz = applicableTimezone(c.timezone, c.organization.timezone);
    const period = billingPeriodFor(c, tz, now);
    await prisma.customer.update({
      where: { id: c.id },
      data: {
        status: 'active',
        startedAt: c.subscriptionAt,
        currentBillingPeriodStartedAt: c.subscriptionAt,
        currentBillingPeriodEndingAt: period.end,
      },
    });
    count += 1;
  }
  return count;
}

export type RollOverSummary = { activated: number; rolledOver: number };

export async function tickRollOver(prisma: PrismaClient, now: Date = new Date()): Promise<RollOverSummary> {
  const activated = await activatePendingCustomers(prisma, now);
  const rolledOver = await runPeriodRollover(prisma, now);
  return { activated, rolledOver };
}
