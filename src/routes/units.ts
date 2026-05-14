// Unit routes — direct CRUD over the materialized unit table.
//
// Cliente teams that prefer to track units explicitly (without sending
// events) can POST/PATCH/DELETE units directly. POSTing an event with
// `operation_type: add` is equivalent to POSTing a unit + an audit event.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeUnit } from '../serializers/unit.js';

type UnitPayload = {
  service_code?: string;
  external_id?: string;
  label?: string | null;
  active_from?: string;
  metadata?: Record<string, unknown>;
};

export function registerUnitRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/units',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { unit?: UnitPayload } | null;
      const payload = body?.unit;
      if (!payload) throw validation({ unit: ['value_is_mandatory'] });
      if (!payload.service_code) throw validation({ service_code: ['value_is_mandatory'] });
      if (!payload.external_id) throw validation({ external_id: ['value_is_mandatory'] });

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.service_code } },
      });
      if (!service) throw notFound('service');

      const existing = await prisma.unit.findUnique({
        where: { serviceId_externalId: { serviceId: service.id, externalId: payload.external_id } },
      });
      if (existing) throw validation({ external_id: ['value_already_exist'] });

      const activeFrom = payload.active_from ? new Date(payload.active_from) : new Date();
      if (Number.isNaN(activeFrom.getTime())) throw validation({ active_from: ['invalid_iso_datetime'] });

      const unit = await prisma.unit.create({
        data: {
          serviceId: service.id,
          externalId: payload.external_id,
          label: payload.label ?? null,
          activeFrom,
          metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      reply.send(serializeUnit(unit));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/units',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; service_code?: string; status?: 'active' | 'terminated' };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.UnitWhereInput = { service: { organizationId: org.id } };
      if (q.service_code) {
        const svc = await prisma.service.findUnique({
          where: { organizationId_code: { organizationId: org.id, code: q.service_code } },
        });
        if (!svc) {
          reply.send({ units: [], meta: emptyMeta(page) });
          return;
        }
        where.serviceId = svc.id;
      }
      if (q.status === 'active') where.activeTo = null;
      if (q.status === 'terminated') where.activeTo = { not: null };
      const [items, totalCount] = await Promise.all([
        prisma.unit.findMany({
          where,
          orderBy: [{ activeFrom: 'desc' }, { externalId: 'asc' }],
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.unit.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        units: items.map((u) => serializeUnit(u).unit),
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
    url: '/api/v1/units/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const unit = await prisma.unit.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!unit) throw notFound('unit');
      reply.send(serializeUnit(unit));
    },
  });

  // PATCH: update label or terminate (set active_to).
  app.route({
    method: 'PATCH',
    url: '/api/v1/units/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { unit?: { label?: string; active_to?: string | null; metadata?: Record<string, unknown> } };
      const payload = body.unit ?? {};
      const unit = await prisma.unit.findFirst({ where: { id, service: { organizationId: org.id } } });
      if (!unit) throw notFound('unit');
      const data: Prisma.UnitUpdateInput = {};
      if (payload.label !== undefined) data.label = payload.label;
      if (payload.active_to !== undefined) {
        data.activeTo = payload.active_to === null ? null : new Date(payload.active_to);
      }
      if (payload.metadata !== undefined) {
        data.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
      }
      const updated = await prisma.unit.update({ where: { id: unit.id }, data });
      reply.send(serializeUnit(updated));
    },
  });
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}
