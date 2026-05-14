// Credit note routes (Numaris-native).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { applicableTimezone } from '../services/tz.js';
import { bankersRound } from '../services/rounding.js';
import { serializeCreditNote, type CreditNoteWithRelations } from '../serializers/credit-note.js';
import type { AppConfig } from '../config.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';

type CreditNotePayload = {
  invoice_id?: string;
  reason?: string;
  description?: string;
  credit_amount_cents?: number;
  refund_amount_cents?: number;
  items?: Array<{ fee_id: string; amount_cents: number }>;
};

const VALID_REASONS = new Set([
  'duplicated_charge',
  'product_unsatisfactory',
  'order_change',
  'order_cancellation',
  'fraudulent_charge',
  'other',
]);

export function registerCreditNoteRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  _opts: { config: AppConfig; dispatcher: NetSuiteDispatcher; callbackBaseUrl: string },
): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/credit_notes',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = (request.body ?? {}) as { credit_note?: CreditNotePayload };
      const payload = body.credit_note;
      if (!payload) throw validation({ credit_note: ['value_is_mandatory'] });
      if (!payload.invoice_id) throw validation({ invoice_id: ['value_is_mandatory'] });
      if (!payload.reason || !VALID_REASONS.has(payload.reason)) {
        throw validation({ reason: ['value_is_invalid'] });
      }
      if (!payload.items || payload.items.length === 0) {
        throw validation({ items: ['value_is_mandatory'] });
      }

      const invoice = await prisma.invoice.findFirst({
        where: { id: payload.invoice_id, organizationId: org.id },
        include: {
          fees: true,
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          service: { include: { taxLinks: { include: { tax: true } } } },
        },
      });
      if (!invoice) throw notFound('invoice');
      if (invoice.status !== 'finalized' || invoice.externalDispatchStatus !== 'confirmed') {
        throw new ApiError(422, 'invoice_not_confirmed', {
          errorDetails: { invoice: ['must_be_finalized_and_confirmed'] },
        });
      }

      const feeById = new Map(invoice.fees.map((f) => [f.id, f]));
      for (let i = 0; i < payload.items.length; i++) {
        const it = payload.items[i]!;
        const fee = feeById.get(it.fee_id);
        if (!fee) throw validation({ [`items[${i}].fee_id`]: ['not_found_in_invoice'] });
        if (!Number.isInteger(it.amount_cents) || it.amount_cents <= 0) {
          throw validation({ [`items[${i}].amount_cents`]: ['must_be_positive_integer'] });
        }
        if (it.amount_cents > fee.amountCents) {
          throw validation({ [`items[${i}].amount_cents`]: ['exceeds_fee_amount'] });
        }
      }

      const taxes = invoice.service?.taxLinks.length
        ? invoice.service.taxLinks.map((l) => l.tax)
        : invoice.customer.taxLinks.map((l) => l.tax);
      const subTotal = payload.items.reduce((acc, i) => acc + i.amount_cents, 0);
      const totalRate = taxes.reduce((acc, t) => acc + Number(t.rate), 0);
      const taxesAmountCents = bankersRound(subTotal * (totalRate / 100));
      const totalAmountCents = subTotal + taxesAmountCents;

      if (payload.credit_amount_cents !== undefined && Math.abs(payload.credit_amount_cents - totalAmountCents) > 5) {
        throw validation({ credit_amount_cents: ['must_equal_subtotal_plus_taxes'] });
      }

      const tz = applicableTimezone(invoice.customer.timezone, org.timezone);
      const now = new Date();
      const issuingDate = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('day').toUTC().toJSDate();
      const idemMarker = parseIdemMarker(payload.description ?? '');

      const cn = await prisma.$transaction(async (tx) => {
        const orgUpdate = await tx.organization.update({
          where: { id: org.id },
          data: { creditNoteCounter: { increment: 1 } },
          select: { creditNoteCounter: true },
        });
        const created = await tx.creditNote.create({
          data: {
            organizationId: org.id,
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            sequentialId: orgUpdate.creditNoteCounter,
            status: 'calculated',
            externalDispatchStatus: 'pending',
            creditStatus: 'available',
            reason: payload.reason!,
            description: payload.description ?? null,
            currency: invoice.currency,
            totalAmountCents,
            taxesAmountCents,
            subTotalExcludingTaxesAmountCents: subTotal,
            balanceAmountCents: totalAmountCents,
            creditAmountCents: payload.credit_amount_cents ?? totalAmountCents,
            refundAmountCents: payload.refund_amount_cents ?? 0,
            taxesRate: new Decimal(totalRate) as unknown as Prisma.Decimal,
            issuingDate,
            idempotencyMarker: idemMarker,
          },
        });
        for (const it of payload.items!) {
          await tx.creditNoteItem.create({
            data: {
              creditNoteId: created.id,
              feeId: it.fee_id,
              amountCents: it.amount_cents,
              amountCurrency: invoice.currency,
            },
          });
        }
        for (const tax of taxes) {
          const base = subTotal;
          const amt = bankersRound(base * (Number(tax.rate) / 100));
          await tx.creditNoteAppliedTax.create({
            data: {
              creditNoteId: created.id,
              taxId: tax.id,
              taxName: tax.name,
              taxCode: tax.code,
              taxRate: tax.rate,
              taxDescription: tax.description,
              amountCents: amt,
              amountCurrency: invoice.currency,
              baseAmountCents: base,
            },
          });
        }
        return created;
      });

      const hydrated = await loadCN(prisma, cn.id);
      reply.send(serializeCreditNote(hydrated));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/credit_notes',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; customer_external_id?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.CreditNoteWhereInput = { organizationId: org.id };
      if (q.customer_external_id) {
        const c = await prisma.customer.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId: q.customer_external_id } },
        });
        if (!c) {
          reply.send({ credit_notes: [], meta: emptyMeta(page) });
          return;
        }
        where.customerId = c.id;
      }
      const [items, totalCount] = await Promise.all([
        prisma.creditNote.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
          include: cnInclude(),
        }),
        prisma.creditNote.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        credit_notes: items.map((cn) =>
          serializeCreditNote(cn as unknown as CreditNoteWithRelations).credit_note,
        ),
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
    url: '/api/v1/credit_notes/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const cn = await prisma.creditNote.findFirst({ where: { id, organizationId: org.id }, include: cnInclude() });
      if (!cn) throw notFound('credit_note');
      reply.send(serializeCreditNote(cn as unknown as CreditNoteWithRelations));
    },
  });
}

function parseIdemMarker(description: string): string | null {
  const match = /\[idem:([^\]]+)\]/.exec(description);
  return match ? match[1]! : null;
}

function cnInclude() {
  return {
    customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
    invoice: {
      include: {
        customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
        fees: true,
        appliedTaxes: true,
      },
    },
    items: { include: { fee: true } },
    appliedTaxes: true,
  };
}

async function loadCN(prisma: PrismaClient, id: string): Promise<CreditNoteWithRelations> {
  const cn = await prisma.creditNote.findUnique({ where: { id }, include: cnInclude() });
  if (!cn) throw notFound('credit_note');
  return cn as unknown as CreditNoteWithRelations;
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}
