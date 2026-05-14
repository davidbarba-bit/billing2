// Customer routes (v3 — owns billing cycle).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, pathNotFound, validation } from '../errors.js';
import { buildCustomerSlug } from '../services/slug.js';
import { applicableTimezone, isValidIanaTimezone } from '../services/tz.js';
import { billingPeriodFor } from '../services/billing-engine.js';
import { serializeCustomer, type CustomerWithLinks } from '../serializers/customer.js';

type CustomerPayload = {
  external_id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  tax_identification_number?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  state?: string | null;
  zipcode?: string | null;
  city?: string | null;
  country?: string | null;
  currency?: string;
  timezone?: string | null;
  billing_period_months?: number; // 1 | 3 | 6 | 12
  billing_anchor_day?: number;    // 1..28
  nonrecurring_trigger?: 'immediate' | 'next_cycle';
  subscription_at?: string;
  metadata?: Record<string, unknown>;
  tax_codes?: string[];
};

export function registerCustomerRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/customers',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { customer?: CustomerPayload } | null;
      const payload = body?.customer;
      if (!payload?.external_id) throw validation({ external_id: ['value_is_mandatory'] });
      if (payload.timezone && !isValidIanaTimezone(payload.timezone)) {
        throw validation({ timezone: ['invalid_iana'] });
      }
      const periodMonths = payload.billing_period_months;
      if (periodMonths !== undefined && ![1, 3, 6, 12].includes(periodMonths)) {
        throw validation({ billing_period_months: ['must_be_1_3_6_or_12'] });
      }
      const anchorDay = payload.billing_anchor_day;
      if (anchorDay !== undefined && (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 28)) {
        throw validation({ billing_anchor_day: ['must_be_1_to_28'] });
      }
      const trigger = payload.nonrecurring_trigger;
      if (trigger !== undefined && trigger !== 'immediate' && trigger !== 'next_cycle') {
        throw validation({ nonrecurring_trigger: ['value_is_invalid'] });
      }

      const taxes = payload.tax_codes !== undefined
        ? await prisma.tax.findMany({ where: { organizationId: org.id, code: { in: payload.tax_codes } } })
        : null;
      if (taxes && taxes.length !== payload.tax_codes!.length) {
        const found = new Set(taxes.map((t) => t.code));
        const missing = payload.tax_codes!.filter((c) => !found.has(c));
        throw validation({ tax_codes: missing.map(() => 'not_found_in_organization') });
      }

      const existing = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.external_id } },
      });

      const updates = buildUpdateData(payload);

      let customer;
      if (existing) {
        customer = await prisma.$transaction(async (tx) => {
          const updated = await tx.customer.update({ where: { id: existing.id }, data: updates });
          if (payload.tax_codes !== undefined && taxes) {
            await tx.customerTaxLink.deleteMany({ where: { customerId: existing.id } });
            await tx.customerTaxLink.createMany({ data: taxes.map((t) => ({ customerId: existing.id, taxId: t.id })) });
          }
          return updated;
        });
      } else {
        if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
        if (!payload.currency) throw validation({ currency: ['value_is_mandatory'] });

        const now = new Date();
        const subscriptionAt = payload.subscription_at ? new Date(payload.subscription_at) : now;
        if (Number.isNaN(subscriptionAt.getTime())) {
          throw validation({ subscription_at: ['invalid_iso_datetime'] });
        }
        const isFuture = subscriptionAt.getTime() > now.getTime();
        const status = isFuture ? 'pending' : 'active';
        const startedAt = isFuture ? null : subscriptionAt;
        const tz = applicableTimezone(payload.timezone, org.timezone);
        const tempCustomer = {
          billingPeriodMonths: periodMonths ?? 1,
          billingAnchorDay: anchorDay ?? 1,
          subscriptionAt,
        } as unknown as import('@prisma/client').Customer;
        const period = isFuture ? null : billingPeriodFor(tempCustomer, tz, now);

        customer = await prisma.$transaction(async (tx) => {
          const orgUpdated = await tx.organization.update({
            where: { id: org.id },
            data: { customerCounter: { increment: 1 } },
            select: { customerCounter: true, slug: true },
          });
          const sequentialId = orgUpdated.customerCounter;
          const created = await tx.customer.create({
            data: {
              ...buildCreateData(payload),
              organizationId: org.id,
              externalId: payload.external_id!,
              sequentialId,
              slug: buildCustomerSlug(orgUpdated.slug, sequentialId),
              name: payload.name!,
              currency: payload.currency!,
              billingPeriodMonths: periodMonths ?? 1,
              billingAnchorDay: anchorDay ?? 1,
              nonrecurringTrigger: trigger ?? 'next_cycle',
              subscriptionAt,
              startedAt,
              status,
              currentBillingPeriodStartedAt: isFuture ? null : startedAt,
              currentBillingPeriodEndingAt: period?.end ?? null,
            },
          });
          if (taxes && taxes.length > 0) {
            await tx.customerTaxLink.createMany({
              data: taxes.map((t) => ({ customerId: created.id, taxId: t.id })),
            });
          }
          return created;
        });
      }

      const hydrated = await load(prisma, customer.id);
      reply.send(serializeCustomer(hydrated));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/customers',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const [items, totalCount] = await Promise.all([
        prisma.customer.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
          include: { organization: true, taxLinks: { include: { tax: true } } },
        }),
        prisma.customer.count({ where: { organizationId: org.id } }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        customers: items.map((c) => serializeCustomer(c).customer),
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
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      const hydrated = await load(prisma, customer.id);
      reply.send(serializeCustomer(hydrated));
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      const activeServices = await prisma.service.count({ where: { customerId: customer.id, status: 'active' } });
      if (activeServices > 0) {
        throw new ApiError(409, 'customer_has_active_services', {
          errorDetails: { customer: ['terminate_services_first'] },
        });
      }
      await prisma.customer.delete({ where: { id: customer.id } });
      reply.send({ deleted: true, external_id: externalId });
    },
  });

  app.route({
    method: 'PUT',
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async () => { throw pathNotFound(); },
  });
}

function buildCreateData(payload: CustomerPayload): Prisma.CustomerUncheckedCreateInput {
  return {
    organizationId: '',
    externalId: '',
    sequentialId: 0,
    slug: '',
    name: '',
    currency: '',
    subscriptionAt: new Date(),
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    taxIdentificationNumber: payload.tax_identification_number ?? null,
    addressLine1: payload.address_line1 ?? null,
    addressLine2: payload.address_line2 ?? null,
    state: payload.state ?? null,
    zipcode: payload.zipcode ?? null,
    city: payload.city ?? null,
    country: payload.country ?? null,
    timezone: payload.timezone ?? null,
    metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
  };
}

function buildUpdateData(payload: CustomerPayload): Prisma.CustomerUpdateInput {
  const updates: Prisma.CustomerUpdateInput = {};
  if (payload.name !== undefined) updates.name = payload.name ?? '';
  if (payload.email !== undefined) updates.email = payload.email;
  if (payload.phone !== undefined) updates.phone = payload.phone;
  if (payload.tax_identification_number !== undefined) updates.taxIdentificationNumber = payload.tax_identification_number;
  if (payload.address_line1 !== undefined) updates.addressLine1 = payload.address_line1;
  if (payload.address_line2 !== undefined) updates.addressLine2 = payload.address_line2;
  if (payload.state !== undefined) updates.state = payload.state;
  if (payload.zipcode !== undefined) updates.zipcode = payload.zipcode;
  if (payload.city !== undefined) updates.city = payload.city;
  if (payload.country !== undefined) updates.country = payload.country;
  if (payload.currency !== undefined) updates.currency = payload.currency;
  if (payload.timezone !== undefined) updates.timezone = payload.timezone;
  if (payload.billing_period_months !== undefined) updates.billingPeriodMonths = payload.billing_period_months;
  if (payload.billing_anchor_day !== undefined) updates.billingAnchorDay = payload.billing_anchor_day;
  if (payload.nonrecurring_trigger !== undefined) updates.nonrecurringTrigger = payload.nonrecurring_trigger;
  if (payload.metadata !== undefined) updates.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
  return updates;
}

async function load(prisma: PrismaClient, id: string): Promise<CustomerWithLinks> {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { organization: true, taxLinks: { include: { tax: true } } },
  });
  if (!customer) throw notFound('customer');
  return customer;
}
