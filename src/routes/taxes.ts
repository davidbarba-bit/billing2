// Tax routes (Numaris-native, simplified).

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeTax } from '../serializers/tax.js';

type TaxPayload = {
  name?: string;
  code?: string;
  description?: string | null;
  rate?: string | number;
};

export function registerTaxRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/taxes',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { tax?: TaxPayload } | null;
      const payload = body?.tax;
      if (!payload) throw validation({ tax: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      const rate = typeof payload.rate === 'string' ? Number(payload.rate) : payload.rate;
      if (rate === undefined || rate === null || !Number.isFinite(rate)) {
        throw validation({ rate: ['invalid_number'] });
      }

      const existing = await prisma.tax.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const tax = await prisma.tax.create({
        data: {
          organizationId: org.id,
          name: payload.name,
          code: payload.code,
          description: payload.description ?? null,
          rate: new Decimal(rate),
        },
      });
      reply.send(serializeTax(tax));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/taxes',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const [items, totalCount] = await Promise.all([
        prisma.tax.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.tax.count({ where: { organizationId: org.id } }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        taxes: items.map((t) => serializeTax(t).tax),
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
    url: '/api/v1/taxes/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const tax = await prisma.tax.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!tax) throw notFound('tax');
      reply.send(serializeTax(tax));
    },
  });
}
