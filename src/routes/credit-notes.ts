// Endpoint #12: POST /api/v1/credit_notes.
//
// Only emissible on invoices that are `finalized + confirmed` (have a CFDI
// folio).
//
// Description carries a `[idem:...]` marker; the marker is parsed and saved
// as `idempotencyMarker` so `findAllCustomerCreditNotes` can reconcile (D5).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { applicableTimezone } from '../services/tz.js';
import { bankersRound } from '../services/rounding.js';
import { serializeCreditNote } from '../serializers/credit-note.js';
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

export function registerCreditNoteRoutes(app: FastifyInstance, prisma: PrismaClient, _opts: {
  config: AppConfig;
  dispatcher: NetSuiteDispatcher;
  callbackBaseUrl: string;
}): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/credit_notes',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { credit_note?: CreditNotePayload } | null;
      const payload = body?.credit_note;
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
        include: { fees: true, customer: { include: { organization: true, taxLinks: { include: { tax: true } } } } },
      });
      if (!invoice) throw notFound('invoice');
      if (invoice.status !== 'finalized' || invoice.externalDispatchStatus !== 'confirmed') {
        throw new ApiError(422, 'invoice_not_confirmed', {
          errorDetails: { invoice: ['must_be_finalized_and_confirmed'] },
        });
      }

      const feeById = new Map(invoice.fees.map((f) => [f.id, f]));
      for (let i = 0; i < payload.items.length; i++) {
        const item = payload.items[i]!;
        const fee = feeById.get(item.fee_id);
        if (!fee) {
          throw validation({ [`items[${i}].fee_id`]: ['not_found_in_invoice'] });
        }
        if (!Number.isInteger(item.amount_cents) || item.amount_cents <= 0) {
          throw validation({ [`items[${i}].amount_cents`]: ['must_be_positive_integer'] });
        }
        if (item.amount_cents > fee.amountCents) {
          throw validation({ [`items[${i}].amount_cents`]: ['exceeds_fee_amount'] });
        }
      }

      const subTotalCents = payload.items.reduce((acc, i) => acc + i.amount_cents, 0);
      const taxRatePercent = invoice.customer.taxLinks.reduce((acc, link) => acc + Number(link.tax.rate), 0);
      const taxesAmountCents = bankersRound(subTotalCents * (taxRatePercent / 100));
      const totalAmountCents = subTotalCents + taxesAmountCents;

      if (payload.credit_amount_cents !== undefined) {
        // Tolerance of MX$0.05 (= 5 cents) per spec.
        if (Math.abs(payload.credit_amount_cents - totalAmountCents) > 5) {
          throw validation({
            credit_amount_cents: ['must_equal_subtotal_plus_taxes'],
          });
        }
      }

      const idemMarker = parseIdemMarker(payload.description ?? '');
      const now = new Date();
      const tz = applicableTimezone(invoice.customer.timezone, org.timezone);
      const issuingDate = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('day').toUTC().toJSDate();

      const created = await prisma.$transaction(async (tx) => {
        const orgUpdate = await tx.organization.update({
          where: { id: org.id },
          data: { creditNoteCounter: { increment: 1 } },
          select: { creditNoteCounter: true },
        });
        const cn = await tx.creditNote.create({
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
            subTotalExcludingTaxesAmountCents: subTotalCents,
            balanceAmountCents: totalAmountCents,
            creditAmountCents: payload.credit_amount_cents ?? totalAmountCents,
            refundAmountCents: payload.refund_amount_cents ?? 0,
            taxesRate: new Decimal(taxRatePercent) as unknown as Prisma.Decimal,
            issuingDate,
            idempotencyMarker: idemMarker,
          },
        });
        for (const item of payload.items!) {
          await tx.creditNoteItem.create({
            data: {
              creditNoteId: cn.id,
              feeId: item.fee_id,
              amountCents: item.amount_cents,
              amountCurrency: invoice.currency,
            },
          });
        }
        for (const link of invoice.customer.taxLinks) {
          const tax = link.tax;
          await tx.creditNoteAppliedTax.create({
            data: {
              creditNoteId: cn.id,
              taxId: tax.id,
              taxName: tax.name,
              taxCode: tax.code,
              taxRate: tax.rate,
              taxDescription: tax.description,
              amountCents: taxesAmountCents,
              amountCurrency: invoice.currency,
              baseAmountCents: subTotalCents,
            },
          });
        }
        return cn;
      });

      const hydrated = await loadCreditNote(prisma, created.id);
      reply.send(serializeCreditNote(hydrated));
    },
  });

  // GET /api/v1/customers/:external_id/credit_notes (paginated). Spec
  // mentions this implicitly (used by clients for reconciliation).
  app.route({
    method: 'GET',
    url: '/api/v1/customers/:externalId/credit_notes',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const q = request.query as { per_page?: string; page?: string } | undefined;
      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      const perPage = Math.min(500, Math.max(1, Number(q?.per_page ?? 100)));
      const page = Math.max(1, Number(q?.page ?? 1));
      const [rows, totalCount] = await Promise.all([
        prisma.creditNote.findMany({
          where: { customerId: customer.id },
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
          include: {
            customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
            invoice: { include: { customer: { include: { organization: true, taxLinks: { include: { tax: true } } } }, fees: true, appliedTaxes: true } },
            items: { include: { fee: true } },
            appliedTaxes: true,
          },
        }),
        prisma.creditNote.count({ where: { customerId: customer.id } }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        credit_notes: rows.map((cn) => serializeCreditNote(cn as unknown as Parameters<typeof serializeCreditNote>[0]).credit_note),
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

  // GET /api/v1/credit_notes (global paginated list, Lago-compat).
  app.route({
    method: 'GET',
    url: '/api/v1/credit_notes',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const [rows, totalCount] = await Promise.all([
        prisma.creditNote.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
          include: {
            customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
            invoice: { include: { customer: { include: { organization: true, taxLinks: { include: { tax: true } } } }, fees: true, appliedTaxes: true } },
            items: { include: { fee: true } },
            appliedTaxes: true,
          },
        }),
        prisma.creditNote.count({ where: { organizationId: org.id } }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        credit_notes: rows.map((cn) => serializeCreditNote(cn as unknown as Parameters<typeof serializeCreditNote>[0]).credit_note),
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

  // GET /api/v1/credit_notes/:lago_id (single read, Lago-compat).
  app.route({
    method: 'GET',
    url: '/api/v1/credit_notes/:lagoId',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { lagoId } = request.params as { lagoId: string };
      const cn = await prisma.creditNote.findFirst({
        where: { id: lagoId, organizationId: org.id },
        include: {
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          invoice: { include: { customer: { include: { organization: true, taxLinks: { include: { tax: true } } } }, fees: true, appliedTaxes: true } },
          items: { include: { fee: true } },
          appliedTaxes: true,
        },
      });
      if (!cn) throw notFound('credit_note');
      reply.send(serializeCreditNote(cn as unknown as Parameters<typeof serializeCreditNote>[0]));
    },
  });
}

function parseIdemMarker(description: string): string | null {
  const match = /\[idem:([^\]]+)\]/.exec(description);
  return match ? match[1]! : null;
}

async function loadCreditNote(prisma: PrismaClient, id: string) {
  const cn = await prisma.creditNote.findUnique({
    where: { id },
    include: {
      customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
      invoice: { include: { customer: { include: { organization: true, taxLinks: { include: { tax: true } } } }, fees: true, appliedTaxes: true } },
      items: { include: { fee: true } },
      appliedTaxes: true,
    },
  });
  if (!cn) throw notFound('credit_note');
  return cn;
}
