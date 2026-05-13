// Endpoint #8: GET /api/v1/customers/:external_id/current_usage.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Subscription, Customer, Charge, BillableMetric } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { applicableTimezone, anniversaryBillingPeriod, calendarBillingPeriod, isoDateIn, isoUtc } from '../services/tz.js';
import { unitsForUsage, amountStringToCents, bankersRound } from '../services/rounding.js';
import { buildUnitIntervals, computeUnitFraction } from '../services/proration.js';
import { Decimal } from '@prisma/client/runtime/library';

export function registerUsageRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'GET',
    url: '/api/v1/customers/:externalId/current_usage',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const q = request.query as
        | { external_subscription_id?: string; apply_taxes?: string }
        | undefined;

      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
        include: { taxLinks: { include: { tax: true } } },
      });
      if (!customer) throw notFound('customer');

      const customerSubs = await prisma.subscription.findMany({
        where: { customerId: customer.id, status: { in: ['active', 'pending'] } },
      });
      let sub: Subscription | null = null;
      if (q?.external_subscription_id) {
        sub = customerSubs.find((s) => s.externalId === q.external_subscription_id) ?? null;
        if (!sub) throw notFound('subscription');
      } else {
        if (customerSubs.length > 1) {
          throw validation({ external_subscription_id: ['value_is_mandatory'] });
        }
        sub = customerSubs[0] ?? null;
      }
      if (!sub) throw notFound('subscription');

      const tz = applicableTimezone(customer.timezone, org.timezone);
      const now = new Date();
      const rawPeriod = sub.billingTime === 'calendar'
        ? calendarBillingPeriod(now, tz)
        : anniversaryBillingPeriod(sub.subscriptionAt, now, tz);

      const fromDatetime = sub.currentBillingPeriodStartedAt ?? rawPeriod.start;
      const toDatetime = sub.currentBillingPeriodEndingAt ?? rawPeriod.end;
      // Prorate against the actual active window (D4): if the subscription
      // started mid-month, the denominator is the days from sub start to the
      // end of the period — not the full calendar month.
      const { DateTime } = await import('luxon');
      const fromDt = DateTime.fromJSDate(fromDatetime, { zone: 'utc' }).setZone(tz).startOf('day');
      const toDt = DateTime.fromJSDate(toDatetime, { zone: 'utc' }).setZone(tz);
      const daysInPeriod = Math.max(1, Math.round(toDt.plus({ seconds: 1 }).diff(fromDt, 'days').days));
      const period = { start: fromDatetime, end: toDatetime, daysInPeriod };

      const plan = await prisma.plan.findUnique({
        where: { id: sub.planId },
        include: { charges: { include: { billableMetric: true }, orderBy: { createdAt: 'asc' } } },
      });
      if (!plan) throw notFound('plan');

      const events = await prisma.event.findMany({
        where: {
          organizationId: org.id,
          externalSubscriptionId: sub.externalId,
          timestamp: { gte: fromDatetime, lte: toDatetime },
        },
        orderBy: { timestamp: 'asc' },
      });

      // Lookup unit_labels per (sub, unit).
      const unitLabels = await prisma.unitLabel.findMany({
        where: { customerId: customer.id, externalSubscriptionId: sub.externalId },
      });
      const labelMap = new Map<string, string | null>();
      for (const r of unitLabels) labelMap.set(r.unitExternalId, r.label);

      const applyTaxes = (q?.apply_taxes ?? 'true').toLowerCase() === 'true';

      const chargesUsage = plan.charges.map((charge) => buildChargeUsage({
        charge,
        events: events
          .filter((e) => e.code === charge.billableMetric.code)
          .map((e) => ({
            timestamp: e.timestamp,
            externalSubscriptionId: e.externalSubscriptionId,
            code: e.code,
            properties: (e.properties ?? {}) as Record<string, unknown>,
          })),
        labelMap,
        period,
        tz,
        currency: customer.currency,
      }));

      // Charges fixture 08 emits charges with the *setup* metric first, then
      // the monthly metric — i.e., the order is determined by Plan charges
      // creation order. We preserve insertion order to match.

      const amountCents = chargesUsage.reduce((acc, c) => acc + c.amount_cents, 0);
      let taxesAmountCents = 0;
      if (applyTaxes) {
        // Aggregate per applied tax (assume `customer.tax_codes` apply).
        const rates = customer.taxLinks.map(({ tax }) => Number(tax.rate));
        const totalRate = rates.reduce((a, b) => a + b, 0) / 100;
        taxesAmountCents = bankersRound(amountCents * totalRate);
      }

      reply.send({
        customer_usage: {
          from_datetime: isoUtc(fromDatetime),
          to_datetime: isoUtc(toDatetime),
          issuing_date: isoDateIn(toDatetime, tz),
          currency: customer.currency,
          amount_cents: amountCents,
          total_amount_cents: amountCents + taxesAmountCents,
          taxes_amount_cents: taxesAmountCents,
          lago_invoice_id: null,
          charges_usage: chargesUsage,
        },
      });
    },
  });
}

function buildChargeUsage(args: {
  charge: Charge & { billableMetric: BillableMetric };
  events: Array<{ timestamp: Date; externalSubscriptionId: string; code: string; properties: Record<string, unknown> }>;
  labelMap: Map<string, string | null>;
  period: { start: Date; end: Date; daysInPeriod: number };
  tz: string;
  currency: string;
}) {
  const { charge, events, labelMap, period, tz, currency } = args;
  const props = charge.properties as { amount?: string };
  const unitAmountCents = props.amount ? amountStringToCents(props.amount) : 0;

  const intervals = buildUnitIntervals(
    events.map((e) => ({
      timestamp: e.timestamp,
      externalSubscriptionId: e.externalSubscriptionId,
      code: e.code,
      properties: e.properties as Record<string, unknown> & {
        operation_type?: 'add' | 'remove';
        unit_external_id?: string;
        unit_label?: string;
      },
    })),
    period,
    labelMap,
  );

  let totalFraction = 0;
  let totalAmount = 0;
  for (const unit of intervals) {
    const { fraction } = computeUnitFraction(unit, period, {
      prorated: charge.prorated,
      tz,
    });
    totalFraction += Number(fraction);
    totalAmount += bankersRound(Number(fraction) * unitAmountCents);
  }

  return {
    units: unitsForUsage(totalFraction),
    events_count: events.length,
    amount_cents: totalAmount,
    amount_currency: currency,
    charge: {
      lago_id: charge.id,
      charge_model: charge.chargeModel,
      invoice_display_name: charge.invoiceDisplayName ?? null,
    },
    billable_metric: {
      lago_id: charge.billableMetric.id,
      name: charge.billableMetric.name,
      code: charge.billableMetric.code,
      aggregation_type: charge.billableMetric.aggregationType,
    },
    filters: [],
    grouped_usage: [],
  };
}

// Unused but exported so future refactors don't grep poorly.
export type _Unused = Customer | Decimal;
