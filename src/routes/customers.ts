// Customer routes (v3 — owns billing cycle).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, pathNotFound, validation } from '../errors.js';
import { buildCustomerSlug } from '../services/slug.js';
import { applicableTimezone, isValidIanaTimezone } from '../services/tz.js';
import { billingPeriodFor } from '../services/billing-engine.js';
import { rejectUnknownFields } from '../services/payload.js';
import { serializeCustomer, type CustomerWithLinks } from '../serializers/customer.js';

// El API público acepta solo los campos comerciales del cliente. La
// configuración de facturación (ciclo, día de corte, moneda, timezone, modo
// de cierre) la administra el equipo Numaris desde el admin.
const CREATE_ALLOWED_FIELDS = ['external_id', 'name', 'email', 'phone', 'metadata'] as const;
// PATCH soft fields — currency mantiene su gate, billing schedule sigue por
// su propio endpoint. Mantenemos compat con el conjunto histórico documentado
// para clientes que ya integraron contra esos campos.
const PATCH_ALLOWED_FIELDS = ['name', 'email', 'phone', 'currency', 'timezone', 'metadata'] as const;
const DEFAULT_CURRENCY = 'MXN';

type CustomerPayload = {
  external_id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  metadata?: Record<string, unknown>;
};

function validateCycleInvoiceMode(v: unknown): 'unified' | 'split_by_kind' {
  if (v === undefined) return 'unified';
  if (v !== 'unified' && v !== 'split_by_kind') {
    throw validation({ cycle_invoice_mode: ['must_be_unified_or_split_by_kind'] });
  }
  return v;
}

export function registerCustomerRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/customers',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { customer?: Record<string, unknown> } | null;
      rejectUnknownFields(body?.customer, CREATE_ALLOWED_FIELDS);
      const payload = body?.customer as CustomerPayload | undefined;
      if (!payload?.external_id) throw validation({ external_id: ['value_is_mandatory'] });
      // El external_id viaja en la URL de todos los endpoints del customer
      // y en NetSuite como identificador estable; lo restringimos a un slug
      // ASCII para que no necesite encoding ni se confunda con el nombre
      // comercial (los acentos/espacios delatan ese error humano).
      if (!/^[A-Za-z0-9._-]+$/.test(payload.external_id)) {
        throw validation({ external_id: ['must_be_ascii_slug'] });
      }

      const existing = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.external_id } },
      });

      const updates = buildUpdateData(payload);

      let customer;
      if (existing) {
        customer = await prisma.customer.update({ where: { id: existing.id }, data: updates });
      } else {
        if (!payload.name) throw validation({ name: ['value_is_mandatory'] });

        const now = new Date();
        const subscriptionAt = now;
        const status = 'active';
        const startedAt = subscriptionAt;
        const tz = applicableTimezone(null, org.timezone);
        const tempCustomer = {
          billingPeriodMonths: 1,
          billingAnchorDay: 1,
          billingAnchorMonth: null,
          subscriptionAt,
        } as unknown as import('@prisma/client').Customer;
        const period = billingPeriodFor(tempCustomer, tz, now);

        customer = await prisma.$transaction(async (tx) => {
          const orgUpdated = await tx.organization.update({
            where: { id: org.id },
            data: { customerCounter: { increment: 1 } },
            select: { customerCounter: true, slug: true },
          });
          const sequentialId = orgUpdated.customerCounter;
          const created = await tx.customer.create({
            data: {
              ...buildCreateData(payload),
              organizationId: org.id,
              externalId: payload.external_id!,
              sequentialId,
              slug: buildCustomerSlug(orgUpdated.slug, sequentialId),
              name: payload.name!,
              currency: DEFAULT_CURRENCY,
              billingPeriodMonths: 1,
              billingAnchorDay: 1,
              billingAnchorMonth: null,
              nonrecurringTrigger: 'next_cycle',
              cycleInvoiceMode: 'unified',
              subscriptionAt,
              startedAt,
              status,
              currentBillingPeriodStartedAt: startedAt,
              currentBillingPeriodEndingAt: period?.end ?? null,
            },
          });
          // v22: todo cliente arranca con una razón social default. La
          // identidad fiscal se completa después vía el CRUD de razones
          // sociales (legal_name parte del nombre comercial).
          // Fase 5: el external_id de la default copia el del cliente para
          // que NetSuite siga mapeando el mismo handle estable.
          await tx.taxEntity.create({
            data: {
              organizationId: org.id,
              customerId: created.id,
              externalId: created.externalId,
              legalName: created.name,
              isDefault: true,
              active: true,
            },
          });
          return created;
        });
      }

      const hydrated = await load(prisma, customer.id);
      reply.send(serializeCustomer(hydrated));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/customers',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const [items, totalCount] = await Promise.all([
        prisma.customer.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
          include: { organization: true },
        }),
        prisma.customer.count({ where: { organizationId: org.id } }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        customers: items.map((c) => serializeCustomer(c).customer),
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
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      const hydrated = await load(prisma, customer.id);
      reply.send(serializeCustomer(hydrated));
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      const activeServices = await prisma.service.count({ where: { customerId: customer.id, status: 'active' } });
      if (activeServices > 0) {
        throw new ApiError(409, 'customer_has_active_services', {
          errorDetails: { customer: ['terminate_services_first'] },
        });
      }
      await prisma.customer.delete({ where: { id: customer.id } });
      reply.send({ deleted: true, external_id: externalId });
    },
  });

  app.route({
    method: 'PUT',
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async () => { throw pathNotFound(); },
  });

  // v12: edición de soft fields del customer post-creación.
  // Campos permitidos: name, email, phone, tax_identification_number,
  // address_line1, address_line2, state, zipcode, city, country, timezone,
  // currency (con gate), metadata.
  //
  // Para editar billing schedule (subscription_at, anchor_day, period_months,
  // nonrecurring_trigger) usar PATCH /:externalId/billing-schedule. Si se
  // envían acá, se devuelve 422 con use_billing_schedule_endpoint.
  //
  // `currency` es el único soft con gate: si hay invoices no-voided no se
  // puede cambiar (las invoices viejas seguirían en la currency anterior,
  // los reportes se corromperían).
  app.route({
    method: 'PATCH',
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const body = (request.body ?? {}) as { customer?: Record<string, unknown> };
      const payload = body.customer;
      if (!payload) throw validation({ customer: ['value_is_mandatory'] });
      rejectUnknownFields(payload, PATCH_ALLOWED_FIELDS);

      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      if (customer.status === 'terminated') {
        throw new ApiError(409, 'customer_terminated', {
          errorDetails: { customer: ['cannot_edit_terminated_customer'] },
        });
      }

      // Validaciones de soft fields.
      const softPayload = payload as {
        name?: string;
        email?: string | null;
        phone?: string | null;
        tax_identification_number?: string | null;
        address_line1?: string | null;
        address_line2?: string | null;
        state?: string | null;
        zipcode?: string | null;
        city?: string | null;
        country?: string | null;
        currency?: string;
        timezone?: string | null;
        // v13: cache del internal id que NetSuite asigna al customer.
        // Numaris/integración hace POST a NetSuite, lee el id que NetSuite
        // devuelve, y lo guarda acá vía PATCH.
        netsuite_internal_id?: string | null;
        metadata?: Record<string, unknown>;
      };

      if (softPayload.timezone !== undefined && softPayload.timezone !== null && !isValidIanaTimezone(softPayload.timezone)) {
        throw validation({ timezone: ['invalid_iana'] });
      }
      if (softPayload.name !== undefined && (typeof softPayload.name !== 'string' || softPayload.name.trim().length === 0)) {
        throw validation({ name: ['must_not_be_empty'] });
      }

      // Gate para currency: solo si efectivamente cambia.
      if (softPayload.currency !== undefined && softPayload.currency !== customer.currency) {
        const blockingInvoices = await prisma.invoice.count({
          where: { customerId: customer.id, status: { not: 'voided' } },
        });
        if (blockingInvoices > 0) {
          throw new ApiError(409, 'customer_has_invoices', {
            errorDetails: {
              currency: ['cannot_change_with_existing_invoices'],
              blocking_invoice_count: [String(blockingInvoices)],
            },
          });
        }
      }

      // Verificar que al menos un campo soft venga seteado.
      const anySoftField =
        softPayload.name !== undefined
        || softPayload.email !== undefined
        || softPayload.phone !== undefined
        || softPayload.currency !== undefined
        || softPayload.timezone !== undefined
        || softPayload.metadata !== undefined;
      if (!anySoftField) {
        throw validation({ customer: ['at_least_one_field_required'] });
      }

      const data: Prisma.CustomerUpdateInput = {};
      if (softPayload.name !== undefined) data.name = softPayload.name;
      if (softPayload.email !== undefined) data.email = softPayload.email;
      if (softPayload.phone !== undefined) data.phone = softPayload.phone;
      if (softPayload.currency !== undefined) data.currency = softPayload.currency;
      if (softPayload.timezone !== undefined) data.timezone = softPayload.timezone;
      if (softPayload.metadata !== undefined) data.metadata = (softPayload.metadata ?? {}) as Prisma.InputJsonValue;

      const updated = await prisma.customer.update({
        where: { id: customer.id },
        data,
      });
      const hydrated = await load(prisma, updated.id);
      reply.send(serializeCustomer(hydrated));
    },
  });

  // v11: edición del calendario de facturación post-creación.
  //
  // Cambios permitidos (todos opcionales; al menos uno requerido):
  //   - subscription_at         → recalcula el ciclo. Gate: sin invoices no-voided.
  //   - billing_anchor_day      → recalcula el ciclo. Gate: sin invoices no-voided.
  //   - billing_period_months   → recalcula el ciclo. Gate: sin invoices no-voided.
  //   - nonrecurring_trigger    → SIN gate (solo afecta one_off units futuras).
  //
  // Si se cambia uno de los 3 campos con gate y el customer tiene al menos
  // 1 invoice no-voided → 409 customer_has_invoices. La salida limpia para
  // ese caso es void+credit_note de las invoices ofensivas primero.
  //
  // Después de actualizar, recalcula currentBillingPeriodStartedAt/EndingAt
  // vía billingPeriodFor para que la preview muestre el periodo correcto
  // de inmediato. Si el nuevo subscription_at es futuro, el customer
  // queda en status='pending' y currentBillingPeriod* en null (el cron
  // de auto-activación lo levantará cuando subscription_at <= now).
  //
  // Registra un EventLog 'schedule_updated' con el delta para auditoría.
  app.route({
    method: 'PATCH',
    url: '/api/v1/customers/:externalId/billing-schedule',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { externalId } = request.params as { externalId: string };
      const body = (request.body ?? {}) as { billing_schedule?: {
        subscription_at?: string;
        billing_anchor_day?: number;
        billing_period_months?: number;
        billing_anchor_month?: number | null;
        nonrecurring_trigger?: 'immediate' | 'next_cycle';
        // v19: split contable de la cycle invoice. Soft field (no requiere gate).
        cycle_invoice_mode?: 'unified' | 'split_by_kind';
      } };
      const payload = body.billing_schedule;
      if (!payload) throw validation({ billing_schedule: ['value_is_mandatory'] });

      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId } },
      });
      if (!customer) throw notFound('customer');
      if (customer.status === 'terminated') {
        throw new ApiError(409, 'customer_terminated', {
          errorDetails: { customer: ['cannot_edit_schedule_of_terminated_customer'] },
        });
      }

      const hasSubscription = payload.subscription_at !== undefined;
      const hasAnchor = payload.billing_anchor_day !== undefined;
      const hasPeriod = payload.billing_period_months !== undefined;
      const hasAnchorMonth = payload.billing_anchor_month !== undefined;
      const hasTrigger = payload.nonrecurring_trigger !== undefined;
      const hasCycleMode = payload.cycle_invoice_mode !== undefined;
      if (!hasSubscription && !hasAnchor && !hasPeriod && !hasAnchorMonth && !hasTrigger && !hasCycleMode) {
        throw validation({ billing_schedule: ['at_least_one_field_required'] });
      }
      if (hasCycleMode) {
        validateCycleInvoiceMode(payload.cycle_invoice_mode);
      }

      // Validaciones de rango (mismas que en POST).
      let subscriptionAt: Date | undefined;
      if (hasSubscription) {
        subscriptionAt = new Date(payload.subscription_at!);
        if (Number.isNaN(subscriptionAt.getTime())) {
          throw validation({ subscription_at: ['invalid_iso_datetime'] });
        }
      }
      if (hasAnchor) {
        const v = payload.billing_anchor_day!;
        if (!Number.isInteger(v) || v < 1 || v > 28) {
          throw validation({ billing_anchor_day: ['must_be_1_to_28'] });
        }
      }
      if (hasPeriod) {
        const v = payload.billing_period_months!;
        if (![1, 3, 6, 12].includes(v)) {
          throw validation({ billing_period_months: ['must_be_1_3_6_or_12'] });
        }
      }
      // v15: anchor_month — solo aplica si el periodo resultante es multi-mes.
      // Necesitamos el periodo resultante (puede venir en el patch o ya estar
      // en el customer) para validar correctamente.
      if (hasAnchorMonth) {
        const v = payload.billing_anchor_month;
        if (v !== null) {
          if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 12) {
            throw validation({ billing_anchor_month: ['must_be_1_to_12'] });
          }
          const effectivePeriod = hasPeriod ? payload.billing_period_months! : customer.billingPeriodMonths;
          if (effectivePeriod === 1) {
            throw validation({ billing_anchor_month: ['not_applicable_to_monthly'] });
          }
        }
      }
      if (hasTrigger) {
        const v = payload.nonrecurring_trigger!;
        if (v !== 'immediate' && v !== 'next_cycle') {
          throw validation({ nonrecurring_trigger: ['value_is_invalid'] });
        }
      }

      // Gate: aplica si se cambia cualquiera de los campos que recalculan el
      // ciclo (subscription_at, anchor_day, period_months, anchor_month).
      // nonrecurring_trigger por sí solo NO requiere gate.
      const needsInvoiceGate = hasSubscription || hasAnchor || hasPeriod || hasAnchorMonth;
      if (needsInvoiceGate) {
        const blockingInvoices = await prisma.invoice.count({
          where: { customerId: customer.id, status: { not: 'voided' } },
        });
        if (blockingInvoices > 0) {
          throw new ApiError(409, 'customer_has_invoices', {
            errorDetails: {
              customer: ['void_invoices_before_editing_schedule'],
              blocking_invoice_count: [String(blockingInvoices)],
            },
          });
        }
      }

      const now = new Date();
      const newSubscriptionAt = subscriptionAt ?? customer.subscriptionAt;
      const newAnchor = hasAnchor ? payload.billing_anchor_day! : customer.billingAnchorDay;
      const newPeriodMonths = hasPeriod ? payload.billing_period_months! : customer.billingPeriodMonths;
      const newAnchorMonth: number | null = hasAnchorMonth
        ? (payload.billing_anchor_month ?? null)
        : customer.billingAnchorMonth;
      const newTrigger = hasTrigger ? payload.nonrecurring_trigger! : customer.nonrecurringTrigger;
      const newCycleMode = hasCycleMode ? payload.cycle_invoice_mode! : customer.cycleInvoiceMode;

      // Recalcula currentBillingPeriod* con los nuevos valores.
      const tz = applicableTimezone(customer.timezone, org.timezone);
      const isFuture = newSubscriptionAt.getTime() > now.getTime();
      const tempCustomer = {
        billingPeriodMonths: newPeriodMonths,
        billingAnchorDay: newAnchor,
        billingAnchorMonth: newAnchorMonth,
        subscriptionAt: newSubscriptionAt,
      } as unknown as import('@prisma/client').Customer;
      const period = isFuture ? null : billingPeriodFor(tempCustomer, tz, now);

      // Estado: si el customer estaba `active` y el nuevo subscription_at es
      // futuro, lo regresamos a `pending` para que el cron lo active cuando
      // toque. Si estaba `pending` y ahora subscription_at <= now, lo dejamos
      // `pending` (la activación inline la maneja el handler de POST/invoices
      // o el cron — mantenerlo consistente con esos flows).
      const newStatus = isFuture ? 'pending' : (customer.status === 'pending' ? 'pending' : 'active');
      const newStartedAt = isFuture ? null : (customer.startedAt ?? newSubscriptionAt);

      // Audit: appendable a customer.metadata.schedule_history. EventLog
      // requiere serviceId (no es para eventos customer-level), así que
      // guardamos el histórico inline en metadata. Conserva las últimas 50
      // ediciones para que no crezca sin límite.
      const existingMeta = (customer.metadata as Record<string, unknown> | null) ?? {};
      const existingHistory = Array.isArray(existingMeta.schedule_history)
        ? (existingMeta.schedule_history as unknown[])
        : [];
      const historyEntry = {
        at: now.toISOString(),
        before: {
          subscription_at: customer.subscriptionAt.toISOString(),
          billing_anchor_day: customer.billingAnchorDay,
          billing_period_months: customer.billingPeriodMonths,
          billing_anchor_month: customer.billingAnchorMonth,
          nonrecurring_trigger: customer.nonrecurringTrigger,
          status: customer.status,
        },
        after: {
          subscription_at: newSubscriptionAt.toISOString(),
          billing_anchor_day: newAnchor,
          billing_period_months: newPeriodMonths,
          billing_anchor_month: newAnchorMonth,
          nonrecurring_trigger: newTrigger,
          status: newStatus,
        },
      };
      const newHistory = [...existingHistory, historyEntry].slice(-50);
      const newMetadata = { ...existingMeta, schedule_history: newHistory };

      const updated = await prisma.customer.update({
        where: { id: customer.id },
        data: {
          subscriptionAt: newSubscriptionAt,
          billingAnchorDay: newAnchor,
          billingPeriodMonths: newPeriodMonths,
          billingAnchorMonth: newAnchorMonth,
          nonrecurringTrigger: newTrigger,
          cycleInvoiceMode: newCycleMode,
          status: newStatus,
          startedAt: newStartedAt,
          currentBillingPeriodStartedAt: isFuture ? null : (period?.start ?? newStartedAt ?? null),
          currentBillingPeriodEndingAt: period?.end ?? null,
          metadata: newMetadata as Prisma.InputJsonValue,
        },
      });

      const hydrated = await load(prisma, updated.id);
      reply.send(serializeCustomer(hydrated));
    },
  });
}

function buildCreateData(payload: CustomerPayload): Prisma.CustomerUncheckedCreateInput {
  return {
    organizationId: '',
    externalId: '',
    sequentialId: 0,
    slug: '',
    name: '',
    currency: '',
    subscriptionAt: new Date(),
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
  };
}

function buildUpdateData(payload: CustomerPayload): Prisma.CustomerUpdateInput {
  const updates: Prisma.CustomerUpdateInput = {};
  if (payload.name !== undefined) updates.name = payload.name ?? '';
  if (payload.email !== undefined) updates.email = payload.email;
  if (payload.phone !== undefined) updates.phone = payload.phone;
  if (payload.metadata !== undefined) updates.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
  return updates;
}

async function load(prisma: PrismaClient, id: string): Promise<CustomerWithLinks> {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { organization: true },
  });
  if (!customer) throw notFound('customer');
  return customer;
}
