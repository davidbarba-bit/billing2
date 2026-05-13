// Endpoints #15 + #15b: NetSuite callbacks.
//
//  - Authentication is HMAC-SHA256 over the raw request body using the
//    organization's `netsuite_callback_secret`. Comparison is timing-safe.
//    No secret configured for the org → 403 secret_not_configured (fail-closed).
//    Missing/invalid signature → 401 invalid_signature.
//  - Optional layers (mTLS, IP allowlist) are wired but disabled by default.
//  - Idempotency: same `(lago_id, folio)` returns 200 without re-mutating;
//    different folio over a confirmed record → 409 conflict_folio_changed.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { conflict, forbidden, notFound, unauthorized, validation } from '../errors.js';
import { verifySignatureHeader } from '../services/hmac.js';
import { serializeInvoice } from '../serializers/invoice.js';
import { serializeCreditNote } from '../serializers/credit-note.js';
import type { AppConfig } from '../config.js';

type ExternalInvoicePayload = {
  external_invoice?: {
    folio: string;
    uuid_cfdi?: string;
    system?: string;
    netsuite_internal_id?: string;
    pdf_url?: string;
    xml_url?: string;
    issued_at?: string;
    due_date?: string;
    payment_status?: string;
    total_amount_cents?: number;
    currency?: string;
  };
};

type ExternalCreditNotePayload = {
  external_credit_note?: {
    folio: string;
    uuid_cfdi?: string;
    system?: string;
    netsuite_internal_id?: string;
    pdf_url?: string;
    xml_url?: string;
    issued_at?: string;
    total_amount_cents?: number;
    currency?: string;
  };
};

export function registerExternalConfirmRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  opts: { config: AppConfig },
): void {
  app.route({
    method: 'POST',
    url: '/api/v1/invoices/:lagoId/external-confirm',
    config: { rawBody: true },
    handler: async (request, reply) => {
      const { lagoId } = request.params as { lagoId: string };
      const invoice = await prisma.invoice.findUnique({
        where: { id: lagoId },
        include: {
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          fees: true,
          appliedTaxes: true,
        },
      });
      if (!invoice) throw notFound('invoice');

      await authenticateCallback(request, opts.config, invoice.customer.organization);

      const body = request.body as ExternalInvoicePayload | null;
      const payload = body?.external_invoice;
      if (!payload || !payload.folio) {
        throw validation({ folio: ['value_is_mandatory'] });
      }

      if (invoice.externalInvoiceFolio && invoice.externalInvoiceFolio !== payload.folio) {
        throw conflict('conflict_folio_changed', { folio: ['changed'] });
      }

      // If already confirmed with the same folio, return 200 without mutation.
      if (
        invoice.externalDispatchStatus === 'confirmed'
        && invoice.externalInvoiceFolio === payload.folio
      ) {
        reply.send(serializeInvoice(invoice));
        return;
      }

      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'finalized',
          externalDispatchStatus: 'confirmed',
          number: payload.folio,
          externalInvoiceFolio: payload.folio,
          externalInvoiceUuidCfdi: payload.uuid_cfdi ?? null,
          externalInvoiceSystem: payload.system ?? null,
          externalInvoiceNetsuiteInternalId: payload.netsuite_internal_id ?? null,
          externalInvoicePdfUrl: payload.pdf_url ?? null,
          externalInvoiceXmlUrl: payload.xml_url ?? null,
          externalInvoiceIssuedAt: payload.issued_at ? new Date(payload.issued_at) : new Date(),
          externalInvoiceConfirmedAt: new Date(),
          externalInvoiceDueDate: payload.due_date ? new Date(payload.due_date) : null,
        },
      });

      const hydrated = await prisma.invoice.findUnique({
        where: { id: updated.id },
        include: {
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          fees: true,
          appliedTaxes: true,
        },
      });
      reply.send(serializeInvoice(hydrated!));
    },
  });

  // #15b credit-note external-confirm.
  app.route({
    method: 'POST',
    url: '/api/v1/credit_notes/:lagoId/external-confirm',
    config: { rawBody: true },
    handler: async (request, reply) => {
      const { lagoId } = request.params as { lagoId: string };
      const cn = await prisma.creditNote.findUnique({
        where: { id: lagoId },
        include: {
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          invoice: { include: { customer: { include: { organization: true, taxLinks: { include: { tax: true } } } }, fees: true, appliedTaxes: true } },
          items: { include: { fee: true } },
          appliedTaxes: true,
        },
      });
      if (!cn) throw notFound('credit_note');

      await authenticateCallback(request, opts.config, cn.customer.organization);

      const body = request.body as ExternalCreditNotePayload | null;
      const payload = body?.external_credit_note;
      if (!payload || !payload.folio) {
        throw validation({ folio: ['value_is_mandatory'] });
      }

      if (cn.externalCreditNoteFolio && cn.externalCreditNoteFolio !== payload.folio) {
        throw conflict('conflict_folio_changed', { folio: ['changed'] });
      }

      if (
        cn.externalDispatchStatus === 'confirmed'
        && cn.externalCreditNoteFolio === payload.folio
      ) {
        reply.send(serializeCreditNote(cn));
        return;
      }

      const updated = await prisma.creditNote.update({
        where: { id: cn.id },
        data: {
          status: 'finalized',
          externalDispatchStatus: 'confirmed',
          number: payload.folio,
          externalCreditNoteFolio: payload.folio,
          externalCreditNoteUuidCfdi: payload.uuid_cfdi ?? null,
          externalCreditNoteSystem: payload.system ?? null,
          externalCreditNoteNetsuiteId: payload.netsuite_internal_id ?? null,
          externalCreditNotePdfUrl: payload.pdf_url ?? null,
          externalCreditNoteXmlUrl: payload.xml_url ?? null,
          externalCreditNoteIssuedAt: payload.issued_at ? new Date(payload.issued_at) : new Date(),
          externalCreditNoteConfirmedAt: new Date(),
        },
      });

      const hydrated = await prisma.creditNote.findUnique({
        where: { id: updated.id },
        include: {
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          invoice: { include: { customer: { include: { organization: true, taxLinks: { include: { tax: true } } } }, fees: true, appliedTaxes: true } },
          items: { include: { fee: true } },
          appliedTaxes: true,
        },
      });
      reply.send(serializeCreditNote(hydrated!));
    },
  });
}

async function authenticateCallback(
  request: import('fastify').FastifyRequest,
  config: AppConfig,
  org: { netsuiteCallbackSecret: string | null },
): Promise<void> {
  if (!org.netsuiteCallbackSecret) {
    throw forbidden('secret_not_configured');
  }
  const sig = request.headers['x-netsuite-signature'];
  const sigStr = Array.isArray(sig) ? sig[0] : sig;
  const rawBody = (request as { rawBody?: Buffer | string }).rawBody;
  if (rawBody === undefined || rawBody === null) {
    throw unauthorized('invalid_signature');
  }
  if (!verifySignatureHeader(sigStr, rawBody, org.netsuiteCallbackSecret)) {
    throw unauthorized('invalid_signature');
  }

  if (config.featureNetsuiteCallbackMtls) {
    const clientCert = (request as { socket?: { getPeerCertificate?: () => unknown } }).socket?.getPeerCertificate?.();
    if (!clientCert || typeof clientCert !== 'object' || Object.keys(clientCert as object).length === 0) {
      throw unauthorized('client_cert_required');
    }
  }

  if (config.netsuiteCallbackIpAllowlist.length > 0) {
    const ip = request.ip;
    if (!config.netsuiteCallbackIpAllowlist.includes(ip)) {
      throw forbidden('ip_not_allowed');
    }
  }
}
