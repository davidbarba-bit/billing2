// Fastify app builder. Exposed so unit/integration tests can spin up an
// instance without binding to a port.

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { ApiError, serializeError } from './errors.js';
import type { AppConfig } from './config.js';
import { getPrisma } from './db.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerUnitRoutes } from './routes/units.js';
import { registerServiceAddOnRoutes } from './routes/service-add-ons.js';
import { registerCustomerAddOnRoutes } from './routes/customer-add-ons.js';
import { registerCatalogEventRoutes } from './routes/catalog-events.js';
import { registerEventRoutes } from './routes/events.js';
import { registerInvoiceRoutes } from './routes/invoices.js';
import { registerCreditNoteRoutes } from './routes/credit-notes.js';
import { registerExternalConfirmRoutes } from './routes/external-confirm.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerAdminResetRoute } from './routes/admin-reset.js';
import { FakeNetSuiteDispatcher, RealNetSuiteDispatcher, type NetSuiteDispatcher } from './services/netsuite-dispatcher.js';
import type { PrismaClient } from '@prisma/client';
import { registerAdmin } from './admin/index.js';

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

  app.setErrorHandler(async (err, request, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.status).send(serializeError(err));
      return;
    }
    if ((err as { validation?: unknown }).validation) {
      reply.status(422).send({
        status: 422,
        error: 'Unprocessable Entity',
        code: 'validation_errors',
        error_details: { _root: ['invalid_request_body'] },
      });
      return;
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 401) {
      reply.status(401).header('www-authenticate', 'Basic realm="Numaris Billing admin"');
      if (request.url.startsWith('/admin')) {
        reply.type('text/html').send('<h1>401 Unauthorized</h1><p>Bad credentials.</p>');
      } else {
        reply.send({ status: 401, error: 'Unauthorized', code: 'unauthorized' });
      }
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

  app.get('/health', async () => ({ status: 'ok' }));

  // Friendly landing: hitting the root sends you to the admin back-office
  // (the human-facing UI of Numaris Billing). /docs is the OpenAPI playground for
  // machines, /admin is for humans.
  app.get('/', async (_request, reply) => {
    reply.redirect('/admin', 302);
  });

  // Public API contract discovery (no auth).
  registerDiscoveryRoutes(app);

  // Admin back-office.
  await registerAdmin(app, { config: deps.config, prisma, dispatcher, callbackBaseUrl });

  // Domain routes.
  registerCustomerRoutes(app, prisma);
  registerServiceRoutes(app, prisma);
  registerUnitRoutes(app, prisma, { dispatcher, callbackBaseUrl });
  registerServiceAddOnRoutes(app, prisma);
  registerCustomerAddOnRoutes(app, prisma);
  registerCatalogEventRoutes(app, prisma, { dispatcher, callbackBaseUrl });
  registerEventRoutes(app, prisma, { dispatcher, callbackBaseUrl });
  registerInvoiceRoutes(app, prisma, { config: deps.config, dispatcher, callbackBaseUrl });
  registerCreditNoteRoutes(app, prisma, { config: deps.config, dispatcher, callbackBaseUrl });
  registerExternalConfirmRoutes(app, prisma, { config: deps.config });
  registerAdminResetRoute(app, prisma);

  return app;
}
