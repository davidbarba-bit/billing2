// Lago-compat billable metrics endpoints (extensions over the mini-Lago spec).
//
//   POST   /api/v1/billable_metrics      create
//   GET    /api/v1/billable_metrics      paginated list
//   GET    /api/v1/billable_metrics/:code single read
//
// The mini-Lago spec doesn't list these as baseline because the original
// Numaris setup seeded BMs out-of-band. But the Lago JS client and the
// Replit prototype expect them, so we expose them as Lago-compatible.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeBillableMetric } from '../serializers/billable-metric.js';

type BillableMetricPayload = {
  name?: string;
  code?: string;
  description?: string | null;
  aggregation_type?: string;
  field_name?: string | null;
  recurring?: boolean;
  weighted_interval?: string | null;
};

export function registerBillableMetricRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/billable_metrics',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { billable_metric?: BillableMetricPayload } | null;
      const payload = body?.billable_metric;
      if (!payload) throw validation({ billable_metric: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (!payload.aggregation_type) {
        throw validation({ aggregation_type: ['value_is_mandatory'] });
      }
      if (payload.aggregation_type !== 'unique_count_agg') {
        // v1 only supports unique_count_agg per the spec; mini-Lago rejects
        // others up-front instead of silently accepting and miscounting.
        throw validation({ aggregation_type: ['value_is_invalid'] });
      }

      const existing = await prisma.billableMetric.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const bm = await prisma.billableMetric.create({
        data: {
          organizationId: org.id,
          name: payload.name,
          code: payload.code,
          aggregationType: payload.aggregation_type,
          fieldName: payload.field_name ?? null,
          recurring: payload.recurring ?? false,
          weightedInterval: payload.weighted_interval ?? null,
        },
      });

      reply.send(serializeBillableMetric(bm));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/billable_metrics',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const [items, totalCount] = await Promise.all([
        prisma.billableMetric.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'asc' },
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.billableMetric.count({ where: { organizationId: org.id } }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        billable_metrics: items.map((b) => serializeBillableMetric(b).billable_metric),
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
    url: '/api/v1/billable_metrics/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const bm = await prisma.billableMetric.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!bm) throw notFound('billable_metric');
      reply.send(serializeBillableMetric(bm));
    },
  });
}
