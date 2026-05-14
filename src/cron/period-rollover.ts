// Period roll-over cron.
//
// Two responsibilities:
//   1. Move active services whose `current_billing_period_ending_at` has
//      passed to the next period.
//   2. Activate pending services whose `subscription_at` has now passed.
//
// The cron does NOT emit invoices — that's caller-driven (`POST /invoices`).

import type { PrismaClient, Service } from '@prisma/client';
import { applicableTimezone } from '../services/tz.js';
import { billingPeriodFor } from '../services/billing-engine.js';

export async function runPeriodRollover(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const services = await prisma.service.findMany({
    where: { status: 'active', currentBillingPeriodEndingAt: { lte: now } },
    include: { customer: true, organization: true },
  });
  let count = 0;
  for (const svc of services) {
    const tz = applicableTimezone(svc.customer.timezone, svc.organization.timezone);
    const period = billingPeriodFor(svc, tz, now);
    await prisma.service.update({
      where: { id: svc.id },
      data: {
        currentBillingPeriodStartedAt: period.start,
        currentBillingPeriodEndingAt: period.end,
      },
    });
    count += 1;
  }
  return count;
}

export async function activatePendingServices(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const services = await prisma.service.findMany({
    where: { status: 'pending', subscriptionAt: { lte: now } },
    include: { customer: true, organization: true },
  });
  let activated = 0;
  for (const svc of services) {
    const tz = applicableTimezone(svc.customer.timezone, svc.organization.timezone);
    const period = billingPeriodFor(svc, tz, now);
    await prisma.service.update({
      where: { id: svc.id },
      data: {
        status: 'active',
        startedAt: svc.subscriptionAt,
        currentBillingPeriodStartedAt: svc.subscriptionAt,
        currentBillingPeriodEndingAt: period.end,
      },
    });
    activated += 1;
  }
  return activated;
}

export type RollOverSummary = { activated: number; rolledOver: number };

export async function tickRollOver(prisma: PrismaClient, now: Date = new Date()): Promise<RollOverSummary> {
  const activated = await activatePendingServices(prisma, now);
  const rolledOver = await runPeriodRollover(prisma, now);
  return { activated, rolledOver };
}

export type _Unused = Service;
