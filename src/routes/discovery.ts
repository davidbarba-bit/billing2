// Public discovery endpoints (no auth):
//
//   GET /openapi.json   → full OpenAPI 3.1 spec (machine-readable contract).
//   GET /docs           → Swagger UI HTML page rendered from /openapi.json.
//   GET /api/v1         → tiny JSON index listing every endpoint + links to
//                          the full spec. Easier to consume from a script
//                          when you only need "what's available".
//
// These are intentionally unauthenticated so a consumer can fetch the
// contract before having an API key.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

type SpecPath = Record<string, { summary?: string; tags?: string[]; security?: unknown }>;
type OpenApiDoc = { paths: Record<string, SpecPath>; info: { title: string; version: string } };

let cachedSpec: OpenApiDoc | null = null;

function loadSpec(): OpenApiDoc {
  if (cachedSpec) return cachedSpec;
  // The compiled JS lives in dist/routes/, the spec in docs/. Resolve
  // relative to this file so it works for both `npm run dev` (tsx, src)
  // and `node dist/server.js` (compiled, dist).
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolvePath(here, '../../../docs/openapi.json'), // dev: src/routes → root/docs
    resolvePath(here, '../../docs/openapi.json'),    // prod: dist/routes → root/docs
    resolvePath(process.cwd(), 'docs/openapi.json'), // CWD fallback
  ];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, 'utf8');
      cachedSpec = JSON.parse(content) as OpenApiDoc;
      return cachedSpec;
    } catch {
      continue;
    }
  }
  throw new Error('openapi.json not found in any candidate path');
}

export function registerDiscoveryRoutes(app: FastifyInstance): void {
  app.get('/openapi.json', async (_request, reply) => {
    const spec = loadSpec();
    reply.header('cache-control', 'public, max-age=60').send(spec);
  });

  app.get('/openapi.yaml', async (_request, reply) => {
    // Some tooling prefers YAML; we don't want a YAML dep, so we just send
    // JSON with a hint. Most OpenAPI tools accept JSON regardless of the
    // .yaml extension.
    const spec = loadSpec();
    reply
      .header('content-type', 'application/yaml')
      .header('cache-control', 'public, max-age=60')
      .send(spec);
  });

  // GET /api/v1 — endpoint discovery (lighter than full OpenAPI).
  app.get('/api/v1', async (_request, reply) => {
    const spec = loadSpec();
    const endpoints: Array<{ method: string; path: string; summary: string; tags: string[]; auth: 'bearer' | 'hmac' | 'none' }> = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const security = (op.security ?? null) as Array<Record<string, unknown>> | null;
        let auth: 'bearer' | 'hmac' | 'none' = 'bearer';
        if (security !== null) {
          if (security.length === 0) auth = 'none';
          else if (security.some((s) => 'NetSuiteSignature' in s)) auth = 'hmac';
          else auth = 'bearer';
        }
        endpoints.push({
          method: method.toUpperCase(),
          path,
          summary: op.summary ?? '',
          tags: op.tags ?? [],
          auth,
        });
      }
    }
    endpoints.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
    reply.header('cache-control', 'public, max-age=60').send({
      service: spec.info.title,
      version: spec.info.version,
      endpoints,
      openapi: '/openapi.json',
      docs: '/docs',
    });
  });

  // Minimal Swagger UI HTML page that pulls /openapi.json from this server.
  app.get('/docs', async (_request, reply) => {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>mini-Lago API · Swagger UI</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.addEventListener('load', () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
      });
    });
  </script>
</body>
</html>`;
    reply.type('text/html').send(html);
  });
}
