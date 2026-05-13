// Endpoints #9, #9b, #9c, #10, #10b — add-ons CRUD + findOne + findAll.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { conflict, notFound, validation } from '../errors.js';
import { serializeAddOn } from '../serializers/addon.js';

type AddOnPayload = {
  name?: string;
  code?: string;
  description?: string | null;
  invoice_display_name?: string | null;
  amount_cents?: number;
  amount_currency?: string;
  tax_codes?: string[];
};

export function registerAddOnRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/add_ons',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { add_on?: AddOnPayload } | null;
      const payload = body?.add_on;
      if (!payload) throw validation({ add_on: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (!payload.amount_currency) throw validation({ amount_currency: ['value_is_mandatory'] });
      if (payload.amount_cents === undefined || payload.amount_cents === null) {
        throw validation({ amount_cents: ['value_is_mandatory'] });
      }
      if (!Number.isInteger(payload.amount_cents) || payload.amount_cents <= 0) {
        throw validation({ amount_cents: ['must_be_greater_than_zero'] });
      }

      const existing = await prisma.addOn.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const addOn = await prisma.addOn.create({
        data: {
          organizationId: org.id,
          name: payload.name,
          code: payload.code,
          description: payload.description ?? null,
          invoiceDisplayName: payload.invoice_display_name ?? null,
          amountCents: payload.amount_cents,
          amountCurrency: payload.amount_currency,
        },
      });

      reply.send(serializeAddOn(addOn));
    },
  });

  // #9b PATCH.
  app.route({
    method: 'PATCH',
    url: '/api/v1/add_ons/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const body = request.body as { add_on?: AddOnPayload & { code?: string } } | null;
      const payload = body?.add_on;
      if (!payload) throw validation({ add_on: ['value_is_mandatory'] });
      if (payload.code !== undefined && payload.code !== code) {
        throw validation({ code: ['immutable'] });
      }

      const addOn = await prisma.addOn.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!addOn) throw notFound('add_on');

      const updates: Prisma.AddOnUpdateInput = {};
      if (payload.name !== undefined) updates.name = payload.name ?? '';
      if (payload.description !== undefined) updates.description = payload.description;
      if (payload.invoice_display_name !== undefined) updates.invoiceDisplayName = payload.invoice_display_name;
      if (payload.amount_currency !== undefined) updates.amountCurrency = payload.amount_currency;
      if (payload.amount_cents !== undefined) {
        if (!Number.isInteger(payload.amount_cents) || payload.amount_cents <= 0) {
          throw validation({ amount_cents: ['must_be_greater_than_zero'] });
        }
        updates.amountCents = payload.amount_cents;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.addOn.update({ where: { id: addOn.id }, data: updates });
        if (payload.tax_codes !== undefined) {
          const taxes = await tx.tax.findMany({
            where: { organizationId: org.id, code: { in: payload.tax_codes } },
          });
          await tx.addOnTaxLink.deleteMany({ where: { addOnId: addOn.id } });
          if (taxes.length > 0) {
            await tx.addOnTaxLink.createMany({
              data: taxes.map((t) => ({ addOnId: addOn.id, taxId: t.id })),
            });
          }
        }
        return u;
      });

      reply.send(serializeAddOn(updated));
    },
  });

  // #9c DELETE.
  app.route({
    method: 'DELETE',
    url: '/api/v1/add_ons/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const addOn = await prisma.addOn.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!addOn) throw notFound('add_on');

      const feeCount = await prisma.fee.count({ where: { addOnId: addOn.id } });
      if (feeCount > 0) {
        throw conflict('add_on_referenced_by_fees', { add_on: ['referenced_by_fees'] });
      }
      const deleted = await prisma.addOn.update({
        where: { id: addOn.id },
        data: { deletedAt: new Date() },
      });
      // Hard-delete after marking soft-deleted so the unique (org, code)
      // constraint stays available for re-creates.
      await prisma.addOn.delete({ where: { id: addOn.id } });
      reply.send(serializeAddOn(deleted, { includeDeletedAt: true }));
    },
  });

  // #10 findOne.
  app.route({
    method: 'GET',
    url: '/api/v1/add_ons/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const addOn = await prisma.addOn.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!addOn) throw notFound('add_on');
      reply.send(serializeAddOn(addOn));
    },
  });

  // #10b findAll paginated.
  app.route({
    method: 'GET',
    url: '/api/v1/add_ons',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string } | undefined;
      const perPage = Math.min(500, Math.max(1, Number(q?.per_page ?? 100)));
      const page = Math.max(1, Number(q?.page ?? 1));
      const [items, totalCount] = await Promise.all([
        prisma.addOn.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'asc' },
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.addOn.count({ where: { organizationId: org.id } }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      const nextPage = page < totalPages ? page + 1 : null;
      const prevPage = page > 1 ? page - 1 : null;
      reply.send({
        add_ons: items.map((a) => serializeAddOn(a).add_on),
        meta: {
          current_page: page,
          next_page: nextPage,
          prev_page: prevPage,
          total_pages: totalPages,
          total_count: totalCount,
        },
      });
    },
  });
}
