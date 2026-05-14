// Top-level entry point.

import { setInterval as setIntervalAsync } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { disconnectPrisma, getPrisma } from './db.js';
import { buildApp } from './app.js';
import { tickCycleBilling } from './cron/cycle-billing.js';
import { FakeNetSuiteDispatcher, RealNetSuiteDispatcher, type NetSuiteDispatcher } from './services/netsuite-dispatcher.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  await ensureDefaultOrganization(prisma, config);

  const dispatcher: NetSuiteDispatcher = config.featureNetsuiteDispatchEnabled
    ? new RealNetSuiteDispatcher()
    : new FakeNetSuiteDispatcher();
  const callbackBaseUrl = config.callbackBaseUrl ?? `http://localhost:${config.port}`;

  const app = await buildApp({ config, prisma, dispatcher, callbackBaseUrl });
  await app.listen({ port: config.port, host: config.host });

  if (config.periodRolloverEnabled) {
    void runCycleBillingLoop(prisma, dispatcher, callbackBaseUrl, app);
  }

  const shutdown = async (): Promise<void> => {
    app.log.info('shutting down…');
    try {
      await app.close();
    } finally {
      await disconnectPrisma();
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

async function runCycleBillingLoop(
  prisma: ReturnType<typeof getPrisma>,
  dispatcher: NetSuiteDispatcher,
  callbackBaseUrl: string,
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<void> {
  // Cada 60s: activa pending, emite cycle invoices vencidas, roll-over.
  // Idempotente por (customer_id, period_from, period_to) — seguro re-correr.
  const intervalMs = 60 * 1000;
  // Primera pasada inmediata al boot por si ya hay cosas pendientes.
  try { await tickCycleBilling({ prisma, dispatcher, callbackBaseUrl, log: app.log }); }
  catch (err) { app.log.error({ err }, 'initial cycle billing tick failed'); }

  for await (const _ of setIntervalAsync(intervalMs)) {
    try {
      await tickCycleBilling({ prisma, dispatcher, callbackBaseUrl, log: app.log });
    } catch (err) {
      app.log.error({ err }, 'cycle billing tick failed');
    }
  }
}

async function ensureDefaultOrganization(
  prisma: ReturnType<typeof getPrisma>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const count = await prisma.organization.count();
  if (count > 0) return;
  await prisma.organization.create({
    data: {
      slug: config.seedDefaultOrgSlug,
      name: 'Default Organization',
      timezone: config.seedDefaultOrgTimezone,
      apiKey: config.seedDefaultApiKey,
      netsuiteCallbackSecret: 'dev-callback-secret-replace-me',
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
