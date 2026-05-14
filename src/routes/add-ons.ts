// Add-on routes — recurring modifiers attached to a Service.
//
// Two pricing types today:
//   - per_unit_monthly: amount × active_units, prorated by days
//   - flat_monthly:     amount × prorated days (independent of units)
//
// Endpoints:
//   POST   /api/v1/services/:code/add-ons   create
//   GET    /api/v1/services/:code/add-ons   list
//   GET    /api/v1/add-ons/:id              read
//   PATCH  /api/v1/add-ons/:id               update (name/description/amount/active_to)
//   DELETE /api/v1/add-ons/:id              terminate (sets active_to=now)

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeAddOn } from '../serializers/add-on.js';

type AddOnPayload = {
  code?: string;
  name?: string;
  description?: string | null;
  pricing_type?: 'per_unit_monthly' | 'flat_monthly';
  amount_cents?: number;
  active_from?: string;
  active_to?: string | null;
  metadata?: Record<string, unknown>;
};

const VALID_PRICING_TYPES = new Set(['per_unit_monthly', 'flat_monthly']);

export function registerAddOnRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  // ------------------------------------------------------------------
  // POST /api/v1/services/:code/add-ons
  // ------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/api/v1/services/:code/add-ons',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code: serviceCode } = request.params as { code: string };
      const body = request.body as { add_on?: AddOnPayload } | null;
      const payload = body?.add_on;
      if (!payload) throw validation({ add_on: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (!payload.pricing_type || !VALID_PRICING_TYPES.has(payload.pricing_type)) {
        throw validation({ pricing_type: ['value_is_invalid'] });
      }
      if (payload.amount_cents === undefined || !Number.isInteger(payload.amount_cents) || payload.amount_cents < 0) {
        throw validation({ amount_cents: ['must_be_non_negative_integer'] });
      }

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: serviceCode } },
      });
      if (!service) throw notFound('service');

      const existing = await prisma.addOn.findUnique({
        where: { serviceId_code: { serviceId: service.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const activeFrom = payload.active_from ? new Date(payload.active_from) : new Date();
      if (Number.isNaN(activeFrom.getTime())) throw validation({ active_from: ['invalid_iso_datetime'] });

      const addOn = await prisma.addOn.create({
        data: {
          serviceId: service.id,
          code: payload.code,
          name: payload.name,
          description: payload.description ?? null,
          pricingType: payload.pricing_type,
          amountCents: payload.amount_cents,
          activeFrom,
          activeTo: payload.active_to ? new Date(payload.active_to) : null,
          metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });

      reply.send(serializeAddOn(addOn));
    },
  });

  // ------------------------------------------------------------------
  // GET /api/v1/services/:code/add-ons
  // ------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/api/v1/services/:code/add-ons',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code: serviceCode } = request.params as { code: string };
      const q = request.query as { per_page?: string; page?: string; status?: 'active' | 'terminated' };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: serviceCode } },
      });
      if (!service) throw notFound('service');
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.AddOnWhereInput = { serviceId: service.id };
      if (q.status === 'active') where.activeTo = null;
      if (q.status === 'terminated') where.activeTo = { not: null };
      const [items, totalCount] = await Promise.all([
        prisma.addOn.findMany({
          where,
          orderBy: [{ activeFrom: 'desc' }, { code: 'asc' }],
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.addOn.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        add_ons: items.map((a) => serializeAddOn(a).add_on),
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

  // ------------------------------------------------------------------
  // GET /api/v1/add-ons/:id
  // ------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/api/v1/add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const addOn = await prisma.addOn.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('add_on');
      reply.send(serializeAddOn(addOn));
    },
  });

  // ------------------------------------------------------------------
  // PATCH /api/v1/add-ons/:id — update name/description/amount/active_to.
  // The pricing_type and code are immutable to keep historical fee
  // attribution stable.
  // ------------------------------------------------------------------
  app.route({
    method: 'PATCH',
    url: '/api/v1/add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { add_on?: Partial<AddOnPayload> };
      const payload = body.add_on ?? {};
      const addOn = await prisma.addOn.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('add_on');
      if (payload.code !== undefined && payload.code !== addOn.code) {
        throw validation({ code: ['immutable'] });
      }
      if (payload.pricing_type !== undefined && payload.pricing_type !== addOn.pricingType) {
        throw validation({ pricing_type: ['immutable'] });
      }
      const data: Prisma.AddOnUpdateInput = {};
      if (payload.name !== undefined) data.name = payload.name ?? '';
      if (payload.description !== undefined) data.description = payload.description;
      if (payload.amount_cents !== undefined) {
        if (!Number.isInteger(payload.amount_cents) || payload.amount_cents < 0) {
          throw validation({ amount_cents: ['must_be_non_negative_integer'] });
        }
        data.amountCents = payload.amount_cents;
      }
      if (payload.active_to !== undefined) {
        data.activeTo = payload.active_to === null ? null : new Date(payload.active_to);
      }
      if (payload.metadata !== undefined) {
        data.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
      }
      const updated = await prisma.addOn.update({ where: { id: addOn.id }, data });
      reply.send(serializeAddOn(updated));
    },
  });

  // ------------------------------------------------------------------
  // DELETE /api/v1/add-ons/:id — soft terminate (sets active_to=now).
  // Re-activate by PATCH'ing active_to: null.
  // ------------------------------------------------------------------
  app.route({
    method: 'DELETE',
    url: '/api/v1/add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const addOn = await prisma.addOn.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('add_on');
      const now = new Date();
      const updated = await prisma.addOn.update({
        where: { id: addOn.id },
        data: { activeTo: addOn.activeTo ?? now },
      });
      reply.send(serializeAddOn(updated));
    },
  });
}
