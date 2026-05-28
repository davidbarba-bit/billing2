// Cron de cierre de ciclo — el "auto-biller".
//
// Cambio vs v3 (D9 original): mini-Lago YA NO espera que alguien externo dispare
// las facturas. Este cron se encarga del ciclo completo:
//
//   1. Activa customers `pending` cuyo `subscription_at` ya pasó.
//   2. Para cada customer `active` cuyo `current_billing_period_ending_at` ya
//      pasó:
//        a. Emite la cycle invoice del periodo que acaba de cerrar
//           (idempotente: si ya existe, skip).
//        b. Despacha a NetSuite.
//        c. Avanza el periodo del customer al siguiente ciclo.
//
// Idempotente por (customer_id, period_from, period_to). Es seguro re-correr
// cada N segundos.

import type { PrismaClient } from '@prisma/client';
import {
  activatePendingCustomerInline,
  emitCycleInvoiceForCustomer,
  rollCustomerPeriodForward,
} from '../services/cycle-billing.js';
import { applicableTimezone } from '../services/tz.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';

export type CycleBillingTickResult = {
  activated: number;
  invoicesEmitted: number;
  invoicesSkippedAsDuplicate: number;
  rolledOver: number;
};

export type CycleBillingOptions = {
  prisma: PrismaClient;
  dispatcher: NetSuiteDispatcher;
  callbackBaseUrl: string;
  log: { info: (data: unknown, msg?: string) => void; error: (data: unknown, msg?: string) => void };
};

export async function tickCycleBilling(opts: CycleBillingOptions, now: Date = new Date()): Promise<CycleBillingTickResult> {
  const { prisma, dispatcher, callbackBaseUrl, log } = opts;
  let activated = 0;
  let invoicesEmitted = 0;
  let invoicesSkippedAsDuplicate = 0;
  let rolledOver = 0;

  // 1) Activate pending customers whose subscription_at has arrived.
  const pendings = await prisma.customer.findMany({
    where: { status: 'pending', subscriptionAt: { lte: now } },
    include: { organization: true },
  });
  for (const c of pendings) {
    const tz = applicableTimezone(c.timezone, c.organization.timezone);
    try {
      await activatePendingCustomerInline(prisma, c, tz, now);
      activated += 1;
    } catch (err) {
      log.error({ err, customer_id: c.id }, 'failed to activate pending customer');
    }
  }

  // 2) Close cycles whose end has passed.
  const duedCustomers = await prisma.customer.findMany({
    where: {
      status: 'active',
      currentBillingPeriodEndingAt: { lte: now },
    },
    include: { organization: true },
  });

  for (const customer of duedCustomers) {
    const tz = applicableTimezone(customer.timezone, customer.organization.timezone);
    try {
      // Emit the invoice for the period that just ended.
      const periodOverride = customer.currentBillingPeriodStartedAt && customer.currentBillingPeriodEndingAt
        ? { from: customer.currentBillingPeriodStartedAt, to: customer.currentBillingPeriodEndingAt }
        : null;
      const result = await emitCycleInvoiceForCustomer({
        prisma,
        dispatcher,
        callbackBaseUrl,
        org: customer.organization,
        customer,
        periodOverride,
        idempotencyKey: `auto-cycle:${customer.id}:${customer.currentBillingPeriodStartedAt?.toISOString() ?? 'now'}`,
        metadata: { source: 'cron_cycle_billing' },
        log,
        now,
      });
      // v19: cuenta cada invoice emitida (puede ser 0, 1 ó 2 según mode + fees).
      if (result.created) invoicesEmitted += result.invoices.length;
      else if (result.invoices.length > 0) invoicesSkippedAsDuplicate += result.invoices.length;

      // Advance the customer's period to the next cycle.
      await rollCustomerPeriodForward(prisma, customer, tz);
      rolledOver += 1;
    } catch (err) {
      log.error({ err, customer_id: customer.id }, 'cycle billing failed for customer');
    }
  }

  if (activated || invoicesEmitted || invoicesSkippedAsDuplicate) {
    log.info({ activated, invoicesEmitted, invoicesSkippedAsDuplicate, rolledOver }, 'cycle billing tick');
  }

  return { activated, invoicesEmitted, invoicesSkippedAsDuplicate, rolledOver };
}
