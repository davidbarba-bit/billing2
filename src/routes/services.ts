// Service routes (v3 — owns units + per-unit pricing, NO billing cycle).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { serializeService, type ServiceWithLinks } from '../serializers/service.js';

type ServicePayload = {
  code?: string;
  customer_external_id?: string;
  name?: string;
  description?: string | null;
  currency?: string;
  monthly_unit_amount_cents?: number;
  setup_unit_amount_cents?: number;
  tax_codes?: string[];
  metadata?: Record<string, unknown>;
};

export function registerServiceRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/services',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { service?: ServicePayload } | null;
      const payload = body?.service;
      if (!payload) throw validation({ service: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (!payload.customer_external_id) {
        throw validation({ customer_external_id: ['value_is_mandatory'] });
      }

      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.customer_external_id } },
      });
      if (!customer) throw notFound('customer');

      const existing = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const monthlyAmount = payload.monthly_unit_amount_cents ?? 0;
      const setupAmount = payload.setup_unit_amount_cents ?? 0;
      if (monthlyAmount < 0 || setupAmount < 0) {
        throw validation({ amount: ['must_be_non_negative'] });
      }

      const taxes = payload.tax_codes
        ? await prisma.tax.findMany({ where: { organizationId: org.id, code: { in: payload.tax_codes } } })
        : null;
      if (taxes && taxes.length !== payload.tax_codes!.length) {
        const found = new Set(taxes.map((t) => t.code));
        const missing = payload.tax_codes!.filter((c) => !found.has(c));
        throw validation({ tax_codes: missing.map(() => 'not_found_in_organization') });
      }

      const currency = payload.currency ?? customer.currency;

      const created = await prisma.$transaction(async (tx) => {
        const service = await tx.service.create({
          data: {
            organizationId: org.id,
            customerId: customer.id,
            code: payload.code!,
            name: payload.name!,
            description: payload.description ?? null,
            currency,
            monthlyUnitAmountCents: monthlyAmount,
            setupUnitAmountCents: setupAmount,
            metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
          },
        });
        if (taxes && taxes.length > 0) {
          await tx.serviceTaxLink.createMany({
            data: taxes.map((t) => ({ serviceId: service.id, taxId: t.id })),
          });
        }
        return service;
      });

      const hydrated = await load(prisma, created.id);
      reply.send(serializeService(hydrated));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/services',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; customer_external_id?: string; status?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.ServiceWhereInput = { organizationId: org.id };
      if (q.customer_external_id) {
        const c = await prisma.customer.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId: q.customer_external_id } },
        });
        if (!c) { reply.send({ services: [], meta: emptyMeta(page) }); return; }
        where.customerId = c.id;
      }
      if (q.status) where.status = q.status;
      const [items, totalCount] = await Promise.all([
        prisma.service.findMany({
          where, orderBy: { createdAt: 'desc' },
          take: perPage, skip: (page - 1) * perPage,
          include: { taxLinks: { include: { tax: true } } },
        }),
        prisma.service.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        services: items.map((s) => serializeService(s).service),
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
    url: '/api/v1/services/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      const hydrated = await load(prisma, service.id);
      reply.send(serializeService(hydrated));
    },
  });

  app.route({
    method: 'POST',
    url: '/api/v1/services/:code/terminate',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      if (service.status === 'terminated') {
        const hydrated = await load(prisma, service.id);
        reply.send(serializeService(hydrated));
        return;
      }
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.service.update({
          where: { id: service.id },
          data: { status: 'terminated', terminatedAt: now },
        });
        await tx.unit.updateMany({
          where: { serviceId: service.id, activeTo: null },
          data: { activeTo: now },
        });
      });
      const hydrated = await load(prisma, service.id);
      reply.send(serializeService(hydrated));
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/v1/services/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      const feesCount = await prisma.fee.count({ where: { serviceId: service.id } });
      if (feesCount > 0) {
        throw new ApiError(409, 'service_has_fees', {
          errorDetails: { service: ['use_terminate_instead'] },
        });
      }
      await prisma.service.delete({ where: { id: service.id } });
      reply.send({ deleted: true, code });
    },
  });
}

async function load(prisma: PrismaClient, id: string): Promise<ServiceWithLinks> {
  const service = await prisma.service.findUnique({
    where: { id },
    include: { taxLinks: { include: { tax: true } } },
  });
  if (!service) throw notFound('service');
  return service;
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}
