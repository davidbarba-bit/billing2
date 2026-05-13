// Fastify app builder. Exposed so unit/integration tests can spin up an
// instance without binding to a port.

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { ApiError, serializeError } from './errors.js';
import type { AppConfig } from './config.js';
import { getPrisma } from './db.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerTaxRoutes } from './routes/taxes.js';
import { registerEventRoutes } from './routes/events.js';
import { registerPlanRoutes } from './routes/plans.js';
import { registerSubscriptionRoutes } from './routes/subscriptions.js';
import { registerAddOnRoutes } from './routes/addons.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerInvoiceRoutes } from './routes/invoices.js';
import { registerCreditNoteRoutes } from './routes/credit-notes.js';
import { registerExternalConfirmRoutes } from './routes/external-confirm.js';
import { FakeNetSuiteDispatcher, RealNetSuiteDispatcher, type NetSuiteDispatcher } from './services/netsuite-dispatcher.js';
import type { PrismaClient } from '@prisma/client';

export type AppDependencies = {
  config: AppConfig;
  prisma?: PrismaClient;
  dispatcher?: NetSuiteDispatcher;
  callbackBaseUrl?: string;
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const prisma = deps.prisma ?? getPrisma();
  const dispatcher = deps.dispatcher
    ?? (deps.config.featureNetsuiteDispatchEnabled
      ? new RealNetSuiteDispatcher()
      : new FakeNetSuiteDispatcher());
  const callbackBaseUrl = deps.callbackBaseUrl ?? 'http://localhost:3000';

  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      transport: deps.config.nodeEnv === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    disableRequestLogging: deps.config.nodeEnv === 'test',
    trustProxy: true,
  });

  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });

  // Unified error shape (invariant #10).
  app.setErrorHandler(async (err, _request, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.status).send(serializeError(err));
      return;
    }
    // Validation errors from Fastify schemas — none configured yet, but for
    // completeness we keep the branch.
    if ((err as { validation?: unknown }).validation) {
      reply.status(422).send({
        status: 422,
        error: 'Unprocessable Entity',
        code: 'validation_errors',
        error_details: { _root: ['invalid_request_body'] },
      });
      return;
    }
    app.log.error({ err }, 'unhandled error');
    reply.status(500).send({
      status: 500,
      error: 'Internal Server Error',
      code: 'internal_error',
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ status: 404, error: 'Not Found', code: 'resource_not_found' });
  });

  // Health.
  app.get('/health', async () => ({ status: 'ok' }));

  registerCustomerRoutes(app, prisma);
  registerTaxRoutes(app, prisma);
  registerEventRoutes(app, prisma);
  registerPlanRoutes(app, prisma);
  registerSubscriptionRoutes(app, prisma);
  registerAddOnRoutes(app, prisma);
  registerUsageRoutes(app, prisma);
  registerInvoiceRoutes(app, prisma, { config: deps.config, dispatcher, callbackBaseUrl });
  registerCreditNoteRoutes(app, prisma, { config: deps.config, dispatcher, callbackBaseUrl });
  registerExternalConfirmRoutes(app, prisma, { config: deps.config });

  return app;
}
