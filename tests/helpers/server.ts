// Test harness that builds a Fastify app + a fresh organization + API key per
// test scenario. Uses a single fork (vitest config) + per-test transactional
// reset so it's safe to run sequentially.

import type { FastifyInstance } from 'fastify';
import type { Organization, PrismaClient } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { FakeNetSuiteDispatcher } from '../../src/services/netsuite-dispatcher.js';
import { getPrisma } from '../../src/db.js';

export type Harness = {
  app: FastifyInstance;
  prisma: PrismaClient;
  organization: Organization;
  apiKey: string;
  dispatcher: FakeNetSuiteDispatcher;
  authHeader: () => Record<string, string>;
};

// Order matters because of FK cascades.
const TABLES = [
  'idempotency_records',
  'credit_note_applied_taxes',
  'credit_note_items',
  'credit_notes',
  'applied_taxes',
  'fees',
  'invoices',
  'event_log',
  'units',
  'service_add_ons',
  'customer_add_ons',
  'service_tax_links',
  'services',
  'customer_tax_links',
  'taxes',
  'customers',
  'organizations',
];

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export async function buildTestHarness(options: {
  apiKey?: string;
  orgSlug?: string;
  orgTimezone?: string;
  netsuiteCallbackSecret?: string;
  featureFlags?: Partial<{ dispatch: boolean; mtls: boolean }>;
} = {}): Promise<Harness> {
  const prisma = getPrisma();
  await resetDatabase(prisma);

  const apiKey = options.apiKey ?? `test-key-${Math.random().toString(36).slice(2, 10)}`;
  const orgSlug = options.orgSlug ?? `TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const orgTimezone = options.orgTimezone ?? 'America/Mexico_City';

  const organization = await prisma.organization.create({
    data: {
      slug: orgSlug,
      name: 'Test Org',
      timezone: orgTimezone,
      apiKey,
      netsuiteCallbackSecret: options.netsuiteCallbackSecret ?? 'test-callback-secret',
    },
  });

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    FEATURE_NETSUITE_DISPATCH_ENABLED: options.featureFlags?.dispatch ? 'true' : 'false',
    FEATURE_NETSUITE_CALLBACK_MTLS: options.featureFlags?.mtls ? 'true' : 'false',
    LOG_LEVEL: 'silent',
    NETSUITE_CALLBACK_IP_ALLOWLIST: '',
  });

  const dispatcher = new FakeNetSuiteDispatcher();
  const app = await buildApp({ config, prisma, dispatcher, callbackBaseUrl: 'http://test-host' });
  await app.ready();

  return {
    app,
    prisma,
    organization,
    apiKey,
    dispatcher,
    authHeader: () => ({ authorization: `Bearer ${apiKey}` }),
  };
}

export async function closeHarness(h: Harness): Promise<void> {
  await h.app.close();
}
