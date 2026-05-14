// ServiceAddOn routes — per-unit recurring modifier on a service.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeServiceAddOn } from '../serializers/service-add-on.js';

type Payload = {
  code?: string;
  name?: string;
  description?: string | null;
  amount_cents?: number;
  active_from?: string;
  active_to?: string | null;
  metadata?: Record<string, unknown>;
};

export function registerServiceAddOnRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  // POST /api/v1/services/:code/add-ons
  app.route({
    method: 'POST',
    url: '/api/v1/services/:code/add-ons',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code: serviceCode } = request.params as { code: string };
      const body = request.body as { service_add_on?: Payload; add_on?: Payload } | null;
      const payload = body?.service_add_on ?? body?.add_on; // accept both wrappers
      if (!payload) throw validation({ service_add_on: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (payload.amount_cents === undefined || !Number.isInteger(payload.amount_cents) || payload.amount_cents < 0) {
        throw validation({ amount_cents: ['must_be_non_negative_integer'] });
      }

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: serviceCode } },
      });
      if (!service) throw notFound('service');

      const existing = await prisma.serviceAddOn.findUnique({
        where: { serviceId_code: { serviceId: service.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const activeFrom = payload.active_from ? new Date(payload.active_from) : new Date();
      if (Number.isNaN(activeFrom.getTime())) throw validation({ active_from: ['invalid_iso_datetime'] });

      const addOn = await prisma.serviceAddOn.create({
        data: {
          serviceId: service.id,
          code: payload.code,
          name: payload.name,
          description: payload.description ?? null,
          amountCents: payload.amount_cents,
          activeFrom,
          activeTo: payload.active_to ? new Date(payload.active_to) : null,
          metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      reply.send(serializeServiceAddOn(addOn));
    },
  });

  // GET /api/v1/services/:code/add-ons
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
      const where: Prisma.ServiceAddOnWhereInput = { serviceId: service.id };
      if (q.status === 'active') where.activeTo = null;
      if (q.status === 'terminated') where.activeTo = { not: null };
      const [items, totalCount] = await Promise.all([
        prisma.serviceAddOn.findMany({
          where,
          orderBy: [{ activeFrom: 'desc' }, { code: 'asc' }],
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.serviceAddOn.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        service_add_ons: items.map((a) => serializeServiceAddOn(a).service_add_on),
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

  // GET /api/v1/service-add-ons/:id
  app.route({
    method: 'GET',
    url: '/api/v1/service-add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const addOn = await prisma.serviceAddOn.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('service_add_on');
      reply.send(serializeServiceAddOn(addOn));
    },
  });

  // PATCH /api/v1/service-add-ons/:id
  app.route({
    method: 'PATCH',
    url: '/api/v1/service-add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { service_add_on?: Partial<Payload>; add_on?: Partial<Payload> };
      const payload = body.service_add_on ?? body.add_on ?? {};
      const addOn = await prisma.serviceAddOn.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('service_add_on');
      if (payload.code !== undefined && payload.code !== addOn.code) {
        throw validation({ code: ['immutable'] });
      }
      const data: Prisma.ServiceAddOnUpdateInput = {};
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
      if (payload.metadata !== undefined) data.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
      const updated = await prisma.serviceAddOn.update({ where: { id: addOn.id }, data });
      reply.send(serializeServiceAddOn(updated));
    },
  });

  // DELETE /api/v1/service-add-ons/:id (soft terminate)
  app.route({
    method: 'DELETE',
    url: '/api/v1/service-add-ons/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const addOn = await prisma.serviceAddOn.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!addOn) throw notFound('service_add_on');
      const updated = await prisma.serviceAddOn.update({
        where: { id: addOn.id },
        data: { activeTo: addOn.activeTo ?? new Date() },
      });
      reply.send(serializeServiceAddOn(updated));
    },
  });
}
