// Endpoints #1 + #2: POST/GET /api/v1/customers.
//
// POST is an upsert by external_id (D1 + invariant #11). Fields not sent are
// preserved; explicit nulls overwrite. `tax_codes` is a total replacement (D2).
//
// `PUT /api/v1/customers/:external_id` is intentionally a 404
// `resource_not_found` (invariant #11).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, pathNotFound, validation } from '../errors.js';
import { buildCustomerSlug } from '../services/slug.js';
import { isValidIanaTimezone } from '../services/tz.js';
import { loadTaxCounters } from '../services/tax-counters.js';
import { serializeCustomer, type CustomerWithLinks } from '../serializers/customer.js';

type CustomerPayload = {
  external_id?: string;
  name?: string;
  firstname?: string | null;
  lastname?: string | null;
  customer_type?: string | null;
  email?: string | null;
  phone?: string | null;
  url?: string | null;
  logo_url?: string | null;
  legal_name?: string | null;
  legal_number?: string | null;
  tax_identification_number?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  state?: string | null;
  zipcode?: string | null;
  city?: string | null;
  country?: string | null;
  currency?: string;
  timezone?: string | null;
  net_payment_term?: number | null;
  external_salesforce_id?: string | null;
  finalize_zero_amount_invoice?: string;
  shipping_address?: {
    address_line1?: string | null;
    address_line2?: string | null;
    city?: string | null;
    zipcode?: string | null;
    state?: string | null;
    country?: string | null;
  };
  metadata?: Record<string, unknown>;
  tax_codes?: string[];
};

export function registerCustomerRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/customers',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { customer?: CustomerPayload } | null;
      const payload = body?.customer;
      if (!payload || !payload.external_id) {
        throw validation({ external_id: ['value_is_mandatory'] });
      }
      if (payload.timezone && !isValidIanaTimezone(payload.timezone)) {
        throw validation({ timezone: ['invalid_iana'] });
      }
      if (payload.tax_codes !== undefined && !Array.isArray(payload.tax_codes)) {
        throw validation({ tax_codes: ['invalid_type'] });
      }

      const taxes = payload.tax_codes
        ? await prisma.tax.findMany({
            where: { organizationId: org.id, code: { in: payload.tax_codes } },
          })
        : null;
      if (payload.tax_codes && taxes && taxes.length !== payload.tax_codes.length) {
        const found = new Set(taxes.map((t) => t.code));
        const missing = payload.tax_codes.filter((c) => !found.has(c));
        throw validation({ tax_codes: missing.map(() => 'not_found_in_organization') });
      }

      const existing = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.external_id } },
      });

      const updates: Prisma.CustomerUpdateInput = buildCustomerUpdateInput(payload);

      let customer;
      if (existing) {
        customer = await prisma.$transaction(async (tx) => {
          const updated = await tx.customer.update({
            where: { id: existing.id },
            data: updates,
          });
          if (payload.tax_codes !== undefined && taxes) {
            await tx.customerTaxLink.deleteMany({ where: { customerId: existing.id } });
            await tx.customerTaxLink.createMany({
              data: taxes.map((t) => ({ customerId: existing.id, taxId: t.id })),
            });
          }
          return updated;
        });
      } else {
        if (!payload.name) {
          throw validation({ name: ['value_is_mandatory'] });
        }
        if (!payload.currency) {
          throw validation({ currency: ['value_is_mandatory'] });
        }
        customer = await prisma.$transaction(async (tx) => {
          const orgUpdated = await tx.organization.update({
            where: { id: org.id },
            data: { customerCounter: { increment: 1 } },
            select: { customerCounter: true, slug: true },
          });
          const sequentialId = orgUpdated.customerCounter;
          const created = await tx.customer.create({
            data: {
              ...sharedCreateFields(payload),
              organizationId: org.id,
              externalId: payload.external_id!,
              sequentialId,
              slug: buildCustomerSlug(orgUpdated.slug, sequentialId),
              name: payload.name!,
              currency: payload.currency!,
            },
          });
          if (taxes && taxes.length > 0) {
            await tx.customerTaxLink.createMany({
              data: taxes.map((t) => ({ customerId: created.id, taxId: t.id })),
            });
          }
          return created;
        });
      }

      const hydrated = await loadCustomerWithLinks(prisma, customer.id);
      const counters = await loadTaxCounters(prisma, hydrated.taxLinks.map(({ tax }) => tax.id));
      reply.send(serializeCustomer(hydrated, counters));
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
      const hydrated = await loadCustomerWithLinks(prisma, customer.id);
      const counters = await loadTaxCounters(prisma, hydrated.taxLinks.map(({ tax }) => tax.id));
      reply.send(serializeCustomer(hydrated, counters));
    },
  });

  // PUT /customers/:external_id → invariant #11: 404 resource_not_found.
  app.route({
    method: 'PUT',
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async () => {
      throw pathNotFound();
    },
  });

  // DELETE /customers/:external_id (pending subs only, kept here for parity).
  app.route({
    method: 'DELETE',
    url: '/api/v1/customers/:externalId',
    preHandler: authenticate,
    handler: async () => {
      throw new ApiError(405, 'method_not_allowed', { httpError: 'Method Not Allowed' });
    },
  });
}

function buildCustomerUpdateInput(payload: CustomerPayload): Prisma.CustomerUpdateInput {
  const updates: Prisma.CustomerUpdateInput = {};
  if (payload.name !== undefined) updates.name = payload.name ?? '';
  if (payload.firstname !== undefined) updates.firstname = payload.firstname;
  if (payload.lastname !== undefined) updates.lastname = payload.lastname;
  if (payload.customer_type !== undefined) updates.customerType = payload.customer_type;
  if (payload.email !== undefined) updates.email = payload.email;
  if (payload.phone !== undefined) updates.phone = payload.phone;
  if (payload.url !== undefined) updates.url = payload.url;
  if (payload.logo_url !== undefined) updates.logoUrl = payload.logo_url;
  if (payload.legal_name !== undefined) updates.legalName = payload.legal_name;
  if (payload.legal_number !== undefined) updates.legalNumber = payload.legal_number;
  if (payload.tax_identification_number !== undefined) {
    updates.taxIdentificationNumber = payload.tax_identification_number;
  }
  if (payload.address_line1 !== undefined) updates.addressLine1 = payload.address_line1;
  if (payload.address_line2 !== undefined) updates.addressLine2 = payload.address_line2;
  if (payload.state !== undefined) updates.state = payload.state;
  if (payload.zipcode !== undefined) updates.zipcode = payload.zipcode;
  if (payload.city !== undefined) updates.city = payload.city;
  if (payload.country !== undefined) updates.country = payload.country;
  if (payload.currency !== undefined) updates.currency = payload.currency;
  if (payload.timezone !== undefined) updates.timezone = payload.timezone;
  if (payload.net_payment_term !== undefined) updates.netPaymentTerm = payload.net_payment_term;
  if (payload.external_salesforce_id !== undefined) updates.externalSalesforceId = payload.external_salesforce_id;
  if (payload.finalize_zero_amount_invoice !== undefined) {
    updates.finalizeZeroAmountInvoice = payload.finalize_zero_amount_invoice;
  }
  if (payload.shipping_address !== undefined) {
    updates.shippingAddressLine1 = payload.shipping_address.address_line1 ?? null;
    updates.shippingAddressLine2 = payload.shipping_address.address_line2 ?? null;
    updates.shippingCity = payload.shipping_address.city ?? null;
    updates.shippingZipcode = payload.shipping_address.zipcode ?? null;
    updates.shippingState = payload.shipping_address.state ?? null;
    updates.shippingCountry = payload.shipping_address.country ?? null;
  }
  if (payload.metadata !== undefined) {
    updates.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
  }
  return updates;
}

function sharedCreateFields(payload: CustomerPayload): Prisma.CustomerUncheckedCreateInput {
  return {
    organizationId: '',
    externalId: '',
    sequentialId: 0,
    slug: '',
    name: '',
    currency: '',
    firstname: payload.firstname ?? null,
    lastname: payload.lastname ?? null,
    customerType: payload.customer_type ?? null,
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    url: payload.url ?? null,
    logoUrl: payload.logo_url ?? null,
    legalName: payload.legal_name ?? null,
    legalNumber: payload.legal_number ?? null,
    taxIdentificationNumber: payload.tax_identification_number ?? null,
    addressLine1: payload.address_line1 ?? null,
    addressLine2: payload.address_line2 ?? null,
    state: payload.state ?? null,
    zipcode: payload.zipcode ?? null,
    city: payload.city ?? null,
    country: payload.country ?? null,
    timezone: payload.timezone ?? null,
    netPaymentTerm: payload.net_payment_term ?? null,
    externalSalesforceId: payload.external_salesforce_id ?? null,
    finalizeZeroAmountInvoice: payload.finalize_zero_amount_invoice ?? 'inherit',
    shippingAddressLine1: payload.shipping_address?.address_line1 ?? null,
    shippingAddressLine2: payload.shipping_address?.address_line2 ?? null,
    shippingCity: payload.shipping_address?.city ?? null,
    shippingZipcode: payload.shipping_address?.zipcode ?? null,
    shippingState: payload.shipping_address?.state ?? null,
    shippingCountry: payload.shipping_address?.country ?? null,
    metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
  };
}

async function loadCustomerWithLinks(
  prisma: PrismaClient,
  id: string,
): Promise<CustomerWithLinks> {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { organization: true, taxLinks: { include: { tax: true } } },
  });
  if (!customer) throw notFound('customer');
  return customer;
}
