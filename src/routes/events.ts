// Event log route — append-only con side-effects sobre Unit.
// Cuando aplica, también emite invoices individuales por ping (v4 one_off + immediate).
//
// POST /api/v1/events
//   {
//     "event": {
//       "transaction_id": "...",
//       "service_code": "...",
//       "operation_type": "add" | "remove",
//       "unit_external_id": "...",
//       "unit_label": "...",
//       "timestamp": 1747080000,
//       "kind": "...",
//       "properties": { ... }
//     }
//   }
//
// Side-effects:
//   - `add`    → upsert Unit; clear activeTo si re-activa.
//   - `remove` → set Unit.activeTo = timestamp.
//   - Si el event creó/re-activó una Unit en un service con
//     pricing_model='one_off' Y el customer tiene
//     nonrecurring_trigger='immediate' Y la unit todavía no fue cobrada
//     (oneoff_billed_at = null), entonces se emite UNA invoice individual
//     para esa unit y se dispatcha a NetSuite. El response incluye
//     `triggered_invoice_id`.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeEvent } from '../serializers/event.js';
import {
  computeOneOffPingInvoice,
  computeRemovalImmediateInvoice,
  markOneOffBilled,
  persistComputedInvoice,
  splitComputedInvoiceByKind,
} from '../services/billing-engine.js';
import { emitImmediateInvoice } from '../services/immediate-invoice.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';
import { rejectUnknownFields } from '../services/payload.js';

// El API público acepta solo los campos del evento de ciclo de vida.
// Información estática sobre la unidad (setup_already_billed,
// one_off_already_billed, billing_starts_at, prepaid_months) vive en
// `POST /api/v1/units` — el alta de la unidad es donde tiene sentido
// declararla, no en cada ping.
const ALLOWED_FIELDS = [
  'transaction_id', 'service_code', 'operation_type', 'unit_external_id',
  'unit_label', 'timestamp', 'kind', 'properties',
] as const;

type EventPayload = {
  transaction_id?: string;
  service_code?: string;
  operation_type?: 'add' | 'remove';
  unit_external_id?: string;
  unit_label?: string | null;
  timestamp?: number | string;
  kind?: string | null;
  properties?: Record<string, unknown>;
};

export function registerEventRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  opts?: { dispatcher?: NetSuiteDispatcher; callbackBaseUrl?: string },
): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/events',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { event?: Record<string, unknown> } | null;
      rejectUnknownFields(body?.event, ALLOWED_FIELDS);
      const payload = body?.event as EventPayload | undefined;
      if (!payload) throw validation({ event: ['value_is_mandatory'] });
      if (!payload.transaction_id) throw validation({ transaction_id: ['value_is_mandatory'] });
      if (!payload.service_code) throw validation({ service_code: ['value_is_mandatory'] });
      if (!payload.unit_external_id) throw validation({ unit_external_id: ['value_is_mandatory'] });
      const op = payload.operation_type;
      if (op !== 'add' && op !== 'remove') throw validation({ operation_type: ['value_is_invalid'] });
      if (payload.timestamp === undefined || payload.timestamp === null) {
        throw validation({ timestamp: ['value_is_mandatory'] });
      }
      if (typeof payload.timestamp !== 'number') {
        throw validation({ timestamp: ['must_be_unix_epoch_seconds'] });
      }
      if (!Number.isFinite(payload.timestamp) || payload.timestamp <= 0) {
        throw validation({ timestamp: ['must_be_unix_epoch_seconds'] });
      }

      const existing = await prisma.eventLog.findUnique({
        where: { organizationId_transactionId: { organizationId: org.id, transactionId: payload.transaction_id } },
      });
      if (existing) throw validation({ transaction_id: ['value_already_exist'] });

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.service_code } },
        include: { customer: true },
      });
      if (!service) throw notFound('service');

      // v8: si la unit con ese external_id en este service fue MIGRADA fuera,
      // rechaza el evento — el cliente debe dirigirlo al service destino. Esto
      // protege contra re-activación accidental tras una migración.
      const existingUnit = await prisma.unit.findUnique({
        where: { serviceId_externalId: { serviceId: service.id, externalId: payload.unit_external_id } },
      });
      if (existingUnit) {
        const meta = (existingUnit.metadata as Record<string, unknown> | null) ?? {};
        if (meta.migrated_to) {
          const target = meta.migrated_to as { service_code?: string };
          throw validation({ unit: [`migrated_to:${target.service_code ?? 'unknown'}`] });
        }
      }

      const timestamp = new Date(payload.timestamp * 1000);

      const result = await prisma.$transaction(async (tx) => {
        // Snapshot del estado previo de la unidad — necesario para detectar
        // la transición "estaba activa → se acaba de dar de baja" y disparar
        // removal_immediate cuando aplique.
        const previousUnit = await tx.unit.findUnique({
          where: { serviceId_externalId: { serviceId: service.id, externalId: payload.unit_external_id! } },
        });

        const unit = await tx.unit.upsert({
          where: { serviceId_externalId: { serviceId: service.id, externalId: payload.unit_external_id! } },
          create: {
            serviceId: service.id,
            externalId: payload.unit_external_id!,
            label: payload.unit_label ?? null,
            activeFrom: timestamp,
            activeTo: op === 'remove' ? timestamp : null,
          },
          update: op === 'add'
            ? { activeTo: null, ...(payload.unit_label !== undefined ? { label: payload.unit_label } : {}) }
            : { activeTo: timestamp, ...(payload.unit_label !== undefined ? { label: payload.unit_label } : {}) },
        });

        const justTerminatedByRemove = op === 'remove'
          && previousUnit !== null
          && previousUnit.activeTo === null
          && unit.activeTo !== null;

        const event = await tx.eventLog.create({
          data: {
            organizationId: org.id,
            transactionId: payload.transaction_id!,
            serviceId: service.id,
            unitId: unit.id,
            unitExternalId: payload.unit_external_id!,
            unitLabel: payload.unit_label ?? null,
            operationType: op,
            kind: payload.kind ?? null,
            timestamp,
            properties: (payload.properties ?? {}) as object,
          },
        });

        // Trigger immediate one-off invoice si aplica.
        // v8: si la unit tiene billing_starts_at > timestamp, la facturación
        // se difiere. En modo immediate eso significa: NO emitimos invoice
        // ahora; la unit queda `oneoffBilledAt = null` esperando un trigger
        // posterior. Recomendación al usuario: para clientes que requieran
        // delay de billing one_off, usar nonrecurring_trigger='next_cycle'
        // donde el cron / cycle invoice lo recoge automáticamente.
        const effectiveBillingStart = unit.billingStartsAt ?? unit.activeFrom;
        const triggeredInvoiceIds: string[] = [];
        const isImmediateOneOff = op === 'add'
          && service.pricingModel === 'one_off'
          && service.customer.nonrecurringTrigger === 'immediate'
          && unit.oneoffBilledAt === null
          && effectiveBillingStart <= timestamp;

        if (isImmediateOneOff) {
          const computed = computeOneOffPingInvoice({ service, unit, now: timestamp });

          // v19: si el customer está en split_by_kind, partimos el ping en
          // hasta 2 invoices (mensualidades prepagadas = kind one_off = renta,
          // separadas del setup). En 'unified' (default) sale 1 factura con
          // todo, igual que antes.
          const splits = service.customer.cycleInvoiceMode === 'split_by_kind'
            ? splitComputedInvoiceByKind(computed)
            : [{ kind: 'unified' as const, invoice: computed }];

          const issuingDate = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate());

          for (const split of splits) {
            const orgUpdate = await tx.organization.update({
              where: { id: org.id },
              data: { invoiceCounter: { increment: 1 } },
              select: { invoiceCounter: true },
            });

            // Idempotency: en split, sufijo por kind para que dos calls con la
            // misma transaction_id no creen 4 invoices. En unified mantenemos
            // el key sin sufijo (backward compat con consumers existentes que
            // buscan `event:<transaction_id>`).
            const idemKey = splits.length > 1
              ? `event:${payload.transaction_id}:${split.kind}`
              : `event:${payload.transaction_id}`;

            const invoice = await tx.invoice.create({
              data: {
                organizationId: org.id,
                customerId: service.customer.id,
                taxEntityId: service.taxEntityId,
                sequentialId: orgUpdate.invoiceCounter,
                currency: service.customer.currency,
                status: 'calculated',
                externalDispatchStatus: 'pending',
                paymentStatus: 'pending',
                issuingDate,
                paymentDueDate: issuingDate,
                feesAmountCents: split.invoice.feesAmountCents,
                periodFrom: timestamp,
                periodTo: timestamp,
                unitsAnnex: split.invoice.unitsAnnex as object,
                metadata: {
                  trigger: 'one_off_immediate',
                  transaction_id: payload.transaction_id,
                  // v19: clasifica el documento contable. 'unified' = factura
                  // legacy con todo; 'recurring'/'oneoff' = sub-split.
                  cycle_invoice_kind: split.kind,
                } as object,
                idempotencyKey: idemKey,
              },
            });

            await persistComputedInvoice(tx, invoice.id, split.invoice);
            triggeredInvoiceIds.push(invoice.id);
          }

          // markOneOffBilled aplica una sola vez por unit, independiente del
          // número de invoices emitidas. La unit queda billed para que el
          // siguiente cierre no la re-cobre.
          await markOneOffBilled(tx as unknown as PrismaClient, [unit.id], timestamp);
        }

        // Detecta si la baja recién aplicada debe disparar removal_immediate.
        // La emisión real se hace fuera de la transacción (emitImmediateInvoice
        // abre su propia tx); aquí solo dejamos el flag.
        const needsRemovalImmediate = justTerminatedByRemove
          && unit.removalBilledAt === null
          && service.pricingModel === 'recurring'
          && service.removalBillingMode === 'immediate'
          && service.removalUnitAmountCents > 0;

        return { event, triggeredInvoiceIds, needsRemovalImmediate, unitId: unit.id };
      });

      // Removal immediate fuera de la transacción (emitImmediateInvoice abre
      // la suya propia). Si el evento dio de baja la unidad y el plan tiene
      // removal_billing_mode='immediate' con cargo > 0, emitimos invoice ya.
      if (result.needsRemovalImmediate) {
        const refreshedUnit = await prisma.unit.findUniqueOrThrow({ where: { id: result.unitId } });
        const organization = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
        const computed = computeRemovalImmediateInvoice({ service, unit: refreshedUnit });
        const removalResult = await emitImmediateInvoice({
          prisma, organization, customer: service.customer,
          taxEntityId: service.taxEntityId,
          computed, trigger: 'removal_immediate',
          idempotencyKey: `removal-immediate:${refreshedUnit.id}`,
          markBilled: async (tx) => {
            await tx.unit.update({ where: { id: refreshedUnit.id }, data: { removalBilledAt: new Date() } });
          },
        });
        // Append al array para que el bucle dispatch de abajo lo recoja y la
        // respuesta exponga triggered_invoice_id.
        result.triggeredInvoiceIds.push(removalResult.invoiceId);
      }

      // Dispatch async (fuera de la transacción) por cada invoice creada.
      if (opts?.dispatcher && opts.callbackBaseUrl) {
        for (const invoiceId of result.triggeredInvoiceIds) {
          dispatchInBackground(prisma, org, invoiceId, opts.dispatcher, opts.callbackBaseUrl, request.log);
        }
      }

      const response = serializeEvent(result.event) as Record<string, unknown>;
      if (result.triggeredInvoiceIds.length > 0) {
        // Primary = la primera del array (recurring en modo split; unified en
        // modo unified). Companion expone la segunda si hubo split real, igual
        // que el patrón del POST /api/v1/invoices.
        response.triggered_invoice_id = result.triggeredInvoiceIds[0];
        if (result.triggeredInvoiceIds.length > 1) {
          response.companion_invoice_id = result.triggeredInvoiceIds[1];
        }
      }
      reply.send(response);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/events',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; service_code?: string; unit_external_id?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: import('@prisma/client').Prisma.EventLogWhereInput = { organizationId: org.id };
      if (q.service_code) {
        const svc = await prisma.service.findUnique({
          where: { organizationId_code: { organizationId: org.id, code: q.service_code } },
        });
        if (!svc) {
          reply.send({ events: [], meta: { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 } });
          return;
        }
        where.serviceId = svc.id;
      }
      if (q.unit_external_id) where.unitExternalId = q.unit_external_id;
      const [items, totalCount] = await Promise.all([
        prisma.eventLog.findMany({ where, orderBy: { timestamp: 'desc' }, take: perPage, skip: (page - 1) * perPage }),
        prisma.eventLog.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        events: items.map((e) => serializeEvent(e).event),
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
}

// Dispatch NetSuite "fire and forget" para no bloquear el response del ping.
function dispatchInBackground(
  prisma: PrismaClient,
  org: { id: string; netsuiteAccountId?: string | null },
  invoiceId: string,
  dispatcher: NetSuiteDispatcher,
  callbackBaseUrl: string,
  log: { error: (data: unknown, msg?: string) => void },
): void {
  void (async () => {
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { customer: true, fees: true, taxEntity: true },
      });
      if (!invoice) return;
      const orgRow = await prisma.organization.findUnique({ where: { id: org.id } });
      if (!orgRow) return;
      // Payload a NetSuite: SOLO montos netos. NetSuite calcula los
      // impuestos según la configuración fiscal de la razón social.
      // v22/fase5: customer del payload = razón social.
      const te = invoice.taxEntity;
      const dispatchPayload = {
        external_id: invoice.id,
        minilago_invoice_id: invoice.id,
        issued_at: invoice.createdAt.toISOString(),
        currency: invoice.currency,
        customer: {
          external_id: te.externalId,
          name: te.legalName,
          tax_identification_number: te.taxIdentificationNumber,
          country: te.country,
          netsuite_internal_id: te.netsuiteInternalId,
          netsuite_entity_handle: te.netsuiteInternalId ?? `eid:${te.externalId}`,
          customer_external_id: invoice.customer.externalId,
        },
        billing_period: { from: invoice.periodFrom, to: invoice.periodTo },
        lines: invoice.fees.map((f) => ({
          fee_id: f.id, service_id: f.serviceId, kind: f.kind,
          description: f.description, units: f.units,
          unit_amount_cents: f.unitAmountCents, amount_cents: f.amountCents,
          netsuite_item_code: f.netsuiteItemCode,
          billed_units_detail: f.billedUnitsDetail,
        })),
        units_annex: invoice.unitsAnnex,
        totals: { fees_amount_cents: invoice.feesAmountCents },
        metadata: invoice.metadata ?? {},
        callback_url: `${callbackBaseUrl}/api/v1/invoices/${invoice.id}/external-confirm`,
      };
      const result = await dispatcher.dispatch(orgRow, dispatchPayload, 'invoice');
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: result.status === 'accepted'
          ? { externalDispatchStatus: 'dispatched', netsuiteDispatchId: result.netsuiteInternalId ?? null }
          : { externalDispatchStatus: 'failed', externalDispatchError: result.error ?? 'dispatch_failed' },
      });
    } catch (err) {
      log.error({ err }, 'one_off_immediate dispatch failed');
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { externalDispatchStatus: 'failed', externalDispatchError: err instanceof Error ? err.message : String(err) },
      }).catch(() => undefined);
    }
  })();
}
