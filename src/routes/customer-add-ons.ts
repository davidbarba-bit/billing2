// CustomerAddOn routes — flat recurring modifier on a customer.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeCustomerAddOn } from '../serializers/customer-add-on.js';
import { resolveTaxEntityIdForCustomer } from '../services/tax-entity.js';

type Payload = {
  code?: string;
  name?: string;
  description?: string | null;
  amount_cents?: number;
  // v22: razón social del add-on flat. Vacío → default del cliente.
  tax_entity_id?: string | null;
  // v9: código NetSuite del item asociado a este customer add-on flat.
  netsuite_item_code?: string | null;
  active_from?: string;
  active_to?: string | null;
  metadata?: Record<string, unknown>;
};

function normalizeItemCode(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function registerCustomerAddOnRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  // POST /api/v1/customers/:external_id/add-ons
  app.route({
    method: 'POST',
    url: '/api/v1/customers/:externalId/add-ons',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const body = request.body as { customer_add_on?: Payload; add_on?: Payload } | null;
      const payload = body?.customer_add_on ?? body?.add_on;
      if (!payload) throw validation({ customer_add_on: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (payload.amount_cents === undefined || !Number.isInteger(payload.amount_cents) || payload.amount_cents < 0) {
        throw validation({ amount_cents: ['must_be_non_negative_integer'] });
      }

      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');

      const existing = await prisma.customerAddOn.findUnique({
        where: { customerId_code: { customerId: customer.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const activeFrom = payload.active_from ? new Date(payload.active_from) : new Date();
      if (Number.isNaN(activeFrom.getTime())) throw validation({ active_from: ['invalid_iso_datetime'] });

      // v22: razón social receptora. Si el payload no la especifica, hereda
      // la default del cliente.
      const taxEntityId = await resolveTaxEntityIdForCustomer(prisma, customer.id, payload.tax_entity_id);

      const addOn = await prisma.customerAddOn.create({
        data: {
          customerId: customer.id,
          taxEntityId,
          code: payload.code,
          name: payload.name,
          description: payload.description ?? null,
          amountCents: payload.amount_cents,
          netsuiteItemCode: normalizeItemCode(payload.netsuite_item_code),
          activeFrom,
          activeTo: payload.active_to ? new Date(payload.active_to) : null,
          metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      reply.send(serializeCustomerAddOn(addOn));
    },
  });

  // GET /api/v1/customers/:external_id/add-ons
  app.route({
    method: 'GET',
    url: '/api/v1/customers/:externalId/add-ons',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const q = request.query as { per_page?: string; page?: string; status?: 'active' | 'terminated' };
      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.CustomerAddOnWhereInput = { customerId: customer.id };
      if (q.status === 'active') where.activeTo = null;
      if (q.status === 'terminated') where.activeTo = { not: null };
      const [items, totalCount] = await Promise.all([
        prisma.customerAddOn.findMany({
          where,
          orderBy: [{ activeFrom: 'desc' }, { code: 'asc' }],
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.customerAddOn.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        customer_add_ons: items.map((a) => serializeCustomerAddOn(a).customer_add_on),
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
    url: '/api/v1/customer-add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const addOn = await prisma.customerAddOn.findFirst({
        where: { id, customer: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('customer_add_on');
      reply.send(serializeCustomerAddOn(addOn));
    },
  });

  app.route({
    method: 'PATCH',
    url: '/api/v1/customer-add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { customer_add_on?: Partial<Payload>; add_on?: Partial<Payload> };
      const payload = body.customer_add_on ?? body.add_on ?? {};
      const addOn = await prisma.customerAddOn.findFirst({
        where: { id, customer: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('customer_add_on');
      if (payload.code !== undefined && payload.code !== addOn.code) {
        throw validation({ code: ['immutable'] });
      }
      const data: Prisma.CustomerAddOnUpdateInput = {};
      if (payload.name !== undefined) data.name = payload.name ?? '';
      if (payload.description !== undefined) data.description = payload.description;
      if (payload.tax_entity_id !== undefined) {
        const teId = await resolveTaxEntityIdForCustomer(prisma, addOn.customerId, payload.tax_entity_id);
        data.taxEntity = { connect: { id: teId } };
      }
      if (payload.amount_cents !== undefined) {
        if (!Number.isInteger(payload.amount_cents) || payload.amount_cents < 0) {
          throw validation({ amount_cents: ['must_be_non_negative_integer'] });
        }
        data.amountCents = payload.amount_cents;
      }
      if (payload.netsuite_item_code !== undefined) {
        data.netsuiteItemCode = normalizeItemCode(payload.netsuite_item_code);
      }
      if (payload.active_to !== undefined) {
        data.activeTo = payload.active_to === null ? null : new Date(payload.active_to);
      }
      if (payload.metadata !== undefined) data.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
      const updated = await prisma.customerAddOn.update({ where: { id: addOn.id }, data });
      reply.send(serializeCustomerAddOn(updated));
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/v1/customer-add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const addOn = await prisma.customerAddOn.findFirst({
        where: { id, customer: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('customer_add_on');
      const updated = await prisma.customerAddOn.update({
        where: { id: addOn.id },
        data: { activeTo: addOn.activeTo ?? new Date() },
      });
      reply.send(serializeCustomerAddOn(updated));
    },
  });
}
