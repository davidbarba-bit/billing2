// Endpoint #6: POST /api/v1/plans.
//
// Charges reference billable metrics by UUID (invariant #6). `prorated:true`
// requires `BM.recurring=true` (invariant #5). Only `charge_model: standard`
// is accepted (D8).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializePlan, type PlanWithCharges } from '../serializers/plan.js';

type ChargePayload = {
  billable_metric_id?: string;
  charge_model?: string;
  pay_in_advance?: boolean;
  invoiceable?: boolean;
  prorated?: boolean;
  invoice_display_name?: string | null;
  min_amount_cents?: number;
  properties?: Record<string, unknown>;
};

type PlanPayload = {
  name?: string;
  code?: string;
  interval?: 'monthly' | 'quarterly' | 'yearly';
  amount_cents?: number;
  amount_currency?: string;
  pay_in_advance?: boolean;
  bill_charges_monthly?: boolean | null;
  description?: string | null;
  invoice_display_name?: string | null;
  trial_period?: number | string | null;
  charges?: ChargePayload[];
};

const VALID_INTERVALS = new Set(['monthly', 'quarterly', 'yearly']);

export function registerPlanRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/plans',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { plan?: PlanPayload } | null;
      const payload = body?.plan;
      if (!payload) throw validation({ plan: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (!payload.amount_currency) throw validation({ amount_currency: ['value_is_mandatory'] });
      if (!payload.interval || !VALID_INTERVALS.has(payload.interval)) {
        throw validation({ interval: ['value_is_invalid'] });
      }
      if (payload.amount_cents !== undefined && (!Number.isInteger(payload.amount_cents) || payload.amount_cents < 0)) {
        throw validation({ amount_cents: ['must_be_non_negative_integer'] });
      }

      const existing = await prisma.plan.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const chargesInput = payload.charges ?? [];
      const bmIds = chargesInput.map((c) => c.billable_metric_id).filter((x): x is string => !!x);
      const bms = bmIds.length
        ? await prisma.billableMetric.findMany({
            where: { organizationId: org.id, id: { in: bmIds } },
          })
        : [];
      const bmById = new Map(bms.map((b) => [b.id, b]));

      for (let i = 0; i < chargesInput.length; i++) {
        const c = chargesInput[i]!;
        if (!c.billable_metric_id) {
          throw validation({ [`charges[${i}].billable_metric_id`]: ['value_is_mandatory'] });
        }
        const bm = bmById.get(c.billable_metric_id);
        if (!bm) {
          throw validation({ [`charges[${i}].billable_metric_id`]: ['not_found_in_organization'] });
        }
        if (c.charge_model && c.charge_model !== 'standard') {
          throw validation({ [`charges[${i}].charge_model`]: ['value_is_invalid'] });
        }
        if (c.prorated && !bm.recurring) {
          throw validation({ [`charges[${i}].prorated`]: ['requires_recurring_metric'] });
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const plan = await tx.plan.create({
          data: {
            organizationId: org.id,
            name: payload.name!,
            code: payload.code!,
            interval: payload.interval!,
            amountCents: payload.amount_cents ?? 0,
            amountCurrency: payload.amount_currency!,
            payInAdvance: payload.pay_in_advance ?? false,
            billChargesMonthly: payload.interval === 'monthly' ? null : (payload.bill_charges_monthly ?? null),
            description: payload.description ?? null,
            invoiceDisplayName: payload.invoice_display_name ?? null,
            trialPeriod: payload.trial_period !== undefined && payload.trial_period !== null
              ? (new (await import('@prisma/client/runtime/library')).Decimal(payload.trial_period) as unknown as Prisma.Decimal)
              : null,
          },
        });
        for (const c of chargesInput) {
          await tx.charge.create({
            data: {
              planId: plan.id,
              billableMetricId: c.billable_metric_id!,
              chargeModel: c.charge_model ?? 'standard',
              payInAdvance: c.pay_in_advance ?? false,
              invoiceable: c.invoiceable ?? true,
              prorated: c.prorated ?? false,
              invoiceDisplayName: c.invoice_display_name ?? null,
              minAmountCents: c.min_amount_cents ?? 0,
              properties: (c.properties ?? {}) as object,
            },
          });
        }
        return plan;
      });

      const hydrated = await loadPlanWithCharges(prisma, created.id);
      const [customersCount, activeSubsCount, draftInvoicesCount] = await Promise.all([
        prisma.subscription
          .findMany({ where: { planId: hydrated.id }, select: { customerId: true }, distinct: ['customerId'] })
          .then((rows) => rows.length),
        prisma.subscription.count({ where: { planId: hydrated.id, status: 'active' } }),
        prisma.invoice.count({ where: { organizationId: org.id, status: 'calculated' } }),
      ]);
      reply.send(
        serializePlan(hydrated, {
          customers_count: customersCount,
          active_subscriptions_count: activeSubsCount,
          draft_invoices_count: draftInvoicesCount,
        }),
      );
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/plans',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const [items, totalCount] = await Promise.all([
        prisma.plan.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
          include: { charges: { include: { billableMetric: true }, orderBy: { createdAt: 'asc' } } },
        }),
        prisma.plan.count({ where: { organizationId: org.id } }),
      ]);
      const planIds = items.map((p) => p.id);
      const [subscribersByPlan, activeSubsByPlan, draftCount] = await Promise.all([
        prisma.subscription.findMany({
          where: { planId: { in: planIds } },
          select: { planId: true, customerId: true },
          distinct: ['planId', 'customerId'],
        }),
        prisma.subscription.groupBy({
          by: ['planId'],
          where: { planId: { in: planIds }, status: 'active' },
          _count: { planId: true },
        }),
        prisma.invoice.count({ where: { organizationId: org.id, status: 'calculated' } }),
      ]);
      const customersCountByPlan = new Map<string, number>();
      for (const r of subscribersByPlan) {
        customersCountByPlan.set(r.planId, (customersCountByPlan.get(r.planId) ?? 0) + 1);
      }
      const activeSubsCountByPlan = new Map<string, number>();
      for (const r of activeSubsByPlan) {
        activeSubsCountByPlan.set(r.planId, r._count.planId);
      }
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        plans: items.map((p) => serializePlan(p, {
          customers_count: customersCountByPlan.get(p.id) ?? 0,
          active_subscriptions_count: activeSubsCountByPlan.get(p.id) ?? 0,
          draft_invoices_count: draftCount,
        }).plan),
        meta: {
          current_page: page,
          next_page: page < totalPages ? page + 1 : null,
          prev_page: page > 1 ? page - 1 : null,
          total_pages: totalPages,
          total_count: totalCount,
        },
      });
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/plans/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const plan = await prisma.plan.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!plan) throw notFound('plan');
      const hydrated = await loadPlanWithCharges(prisma, plan.id);
      const [customersCount, activeSubsCount, draftInvoicesCount] = await Promise.all([
        prisma.subscription
          .findMany({ where: { planId: plan.id }, select: { customerId: true }, distinct: ['customerId'] })
          .then((rows) => rows.length),
        prisma.subscription.count({ where: { planId: plan.id, status: 'active' } }),
        prisma.invoice.count({ where: { organizationId: org.id, status: 'calculated' } }),
      ]);
      reply.send(serializePlan(hydrated, {
        customers_count: customersCount,
        active_subscriptions_count: activeSubsCount,
        draft_invoices_count: draftInvoicesCount,
      }));
    },
  });
}

export async function loadPlanWithCharges(
  prisma: PrismaClient,
  id: string,
): Promise<PlanWithCharges> {
  const plan = await prisma.plan.findUnique({
    where: { id },
    include: { charges: { include: { billableMetric: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (!plan) throw new Error(`plan ${id} not found`);
  return plan;
}
