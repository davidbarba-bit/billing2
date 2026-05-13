// Top-level entry point.

import { setInterval as setIntervalAsync } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { disconnectPrisma, getPrisma } from './db.js';
import { buildApp } from './app.js';
import { tickRollOver } from './cron/period-rollover.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  await ensureDefaultOrganization(prisma, config);

  const app = await buildApp({ config, prisma });
  await app.listen({ port: config.port, host: config.host });

  if (config.periodRolloverEnabled) {
    void runRolloverLoop(prisma, app);
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

async function runRolloverLoop(
  prisma: ReturnType<typeof getPrisma>,
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<void> {
  // Simple "every 15 minutes" loop. Replace with a real cron if you need
  // crontab-grained scheduling.
  const intervalMs = 15 * 60 * 1000;
  for await (const _ of setIntervalAsync(intervalMs)) {
    try {
      const summary = await tickRollOver(prisma);
      app.log.debug({ summary }, 'period rollover tick');
    } catch (err) {
      app.log.error({ err }, 'period rollover failed');
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
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
