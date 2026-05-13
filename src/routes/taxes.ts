// Endpoint #3: POST /api/v1/taxes.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { validation } from '../errors.js';
import { serializeTax } from '../serializers/tax.js';
import { loadTaxCounters } from '../services/tax-counters.js';

type TaxPayload = {
  name?: string;
  code?: string;
  description?: string | null;
  rate?: string | number;
  applied_to_organization?: boolean;
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
      if (payload.rate === undefined || payload.rate === null) {
        throw validation({ rate: ['value_is_mandatory'] });
      }
      const rateNumber = typeof payload.rate === 'string' ? Number(payload.rate) : payload.rate;
      if (!Number.isFinite(rateNumber)) {
        throw validation({ rate: ['invalid_number'] });
      }

      const existing = await prisma.tax.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      if (existing) {
        throw validation({ code: ['value_already_exist'] });
      }

      const tax = await prisma.tax.create({
        data: {
          organizationId: org.id,
          name: payload.name,
          code: payload.code,
          description: payload.description ?? null,
          rate: new (await import('@prisma/client/runtime/library')).Decimal(rateNumber) as unknown as Prisma.Decimal,
          appliedToOrganization: Boolean(payload.applied_to_organization),
        },
      });

      const counters = await loadTaxCounters(prisma, [tax.id]);
      reply.send({ tax: serializeTax(tax, counters.get(tax.id)!) });
    },
  });
}
