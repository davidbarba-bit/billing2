# mini-Lago

Motor de cálculo de facturación por uso real + dispatcher hacia NetSuite,
construido contra el spec `mini-lago-handoff/mini-lago-spec.md`.

Stack:

- Node 20+ / TypeScript / ES modules.
- Fastify 5 (HTTP) con `fastify-raw-body` para verificar HMAC del callback.
- Prisma 6 sobre PostgreSQL 16.
- Luxon para timezone IANA (D4).
- Vitest para contract + behavior tests.

## Estructura

```
src/
  app.ts                  # construye la app Fastify (exportada para tests)
  server.ts               # entry point + bootstrap + cron
  config.ts               # carga de env vars
  db.ts                   # singleton Prisma
  auth.ts                 # Bearer per-organización
  errors.ts               # shape unificado de errores (invariante #10)
  routes/                 # 21 endpoints
  services/               # tz, rounding 4-dígitos, hmac, idempotency, proration, dispatcher
  serializers/            # shaping wire response por entidad
  cron/                   # roll-over D9
prisma/
  schema.prisma           # 21 modelos
tests/
  fixtures/lago-pairs/    # 17 pares golden
  golden/                 # runner con strip-list + normalization-table
  behavior/               # 11+ casos de comportamiento (D10/D12/D13/D14/D9)
  unit/                   # rounding, tz, hmac
```

## Endpoints implementados (21 = 16 baseline + 5 extensiones)

| # | Método | Path |
| --- | --- | --- |
| 1 | POST | `/api/v1/customers` (upsert por `external_id`, D1) |
| 2 | GET | `/api/v1/customers/:external_id` |
| 3 | POST | `/api/v1/taxes` |
| 4 / 5 / 13a | POST | `/api/v1/events` (add/remove/labelled — D14) |
| 6 | POST | `/api/v1/plans` |
| 7 / 7b | POST | `/api/v1/subscriptions` (calendar + anniversary) |
| 8 | GET | `/api/v1/customers/:ext/current_usage` |
| 9 / 9b / 9c / 10 / 10b | POST/PATCH/DELETE/GET/GET | `/api/v1/add_ons[/:code]` |
| 11 | POST | `/api/v1/invoices` (calcula + dispatch a NetSuite) |
| 11b | POST | `/api/v1/invoices/:lago_id/void` |
| 12 | POST | `/api/v1/credit_notes` |
| 14 (outbound) | POST | `customrecord_minilago_invoice` (OAuth 1.0a/TBA HMAC-SHA256) |
| 15 / 15b | POST | `/api/v1/invoices(\|credit_notes)/:lago_id/external-confirm` |

PUT `/api/v1/customers/:external_id` responde `404 resource_not_found` (invariante #11).

## Decisiones implementadas (D1–D14)

- **D1** Upsert por `external_id` en POST /customers (sin PUT).
- **D2** `tax_codes[]` se reemplaza completo.
- **D3** `metadata` siempre objeto (nunca `[]`).
- **D4** Timezone IANA por org + customer; `applicable_timezone` resuelto.
  Cierres en la tz aplicable (ej. `2026-06-01T05:59:59Z` para CDMX).
- **D5** Credit notes habilitadas siempre (no premium gate).
- **D6** DELETE add-on con fees → `409 add_on_referenced_by_fees`.
- **D7** `weighted_interval` aceptado y persistido, no afecta agregación.
- **D8** Sólo `charge_model: standard` en v1.
- **D9** Cron sólo hace roll-over; nunca emite invoices.
- **D10** Idempotencia con header + metadata; 4 casos cubiertos
  (mismo body / body distinto / mismatch / ausente).
- **D11** NetSuite outbound con OAuth 1.0a/TBA HMAC-SHA256, detrás del
  feature flag `FEATURE_NETSUITE_DISPATCH_ENABLED`.
- **D12** Callback `/external-confirm` autentica con HMAC-SHA256
  timing-safe (`X-NetSuite-Signature`). Fail-closed sin secret.
  Idempotente por `(lago_id, folio)`; folio distinto → `409 conflict_folio_changed`.
- **D13** Anexo de unidades en dos niveles: `fee.billed_units_detail[]` y
  `invoice.units_annex[]`. `billed_fraction` = string decimal de 4 dígitos.
  Residuo asignado a la unidad con mayor fracción.
- **D14** `properties.unit_label` opcional; el último visto por
  `(external_subscription_id, unit_external_id)` se persiste en `unit_labels`
  y se emite en `billed_units_detail[].label` y `units_annex[].label`.

## Tests

```
npm test               # 49 tests (golden + behavior + unit)
npm run test:golden    # solo golden contract
npm run test:behavior  # solo comportamiento
npm run typecheck
```

Cobertura actual:

- 8 golden tests sobre fixtures literales (customers, taxes, events, plans, add-ons).
- 4 golden tests sobre fixtures sintéticos (invoices, external-confirm, credit-notes, CN external-confirm) — shape match más comportamiento dispatch + folio.
- 22 behavior tests sobre invariantes y D-decisions.
- 13 unit tests sobre rounding, tz y hmac.

## Setup local

Requiere Postgres corriendo en `localhost:5432`. Con Docker:

```
docker compose up -d postgres
cp .env.example .env
npx prisma db push --skip-generate
npm run dev
```

Sin Docker (Ubuntu/Debian con paquete postgres ya instalado):

```
sudo service postgresql start
sudo -u postgres psql -c "CREATE USER minilago WITH PASSWORD 'minilago' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE minilago OWNER minilago;"
sudo -u postgres psql -c "CREATE DATABASE minilago_test OWNER minilago;"
cp .env.example .env
npx prisma db push --skip-generate
DATABASE_URL='postgresql://minilago:minilago@localhost:5432/minilago_test?schema=public' \
  npx prisma db push --skip-generate
npm run dev
```

Para correr la suite contra la DB de tests:

```
DATABASE_URL='postgresql://minilago:minilago@localhost:5432/minilago_test?schema=public' \
  npm test
```

## Smoke test

```
curl -s -X POST http://localhost:3000/api/v1/taxes \
  -H 'Authorization: Bearer dev-api-key-replace-me' \
  -H 'Content-Type: application/json' \
  -d '{"tax":{"name":"IVA","code":"iva-mx-16","rate":"16"}}'
```

## Notas sobre el comparador golden

El runner aplica los dos pasos prescritos por §8 del spec antes de hacer
`deep-equal`:

1. **Strip-list** — saca `lago_id`/`created_at`/`updated_at`/`*_at`/etag/
   `x-request-id`/UUIDs por referencia, además de los humán-determinísticos
   que dependen de contadores per-org (`sequential_id`, `slug`,
   `customers_count`, etc.).
2. **Normalization-table** — aplica las divergencias listadas al final del
   spec (timezone echo, applicable_timezone resuelto, `metadata: []` ↔ `{}`).

Los fixtures #11, #12, #14, #15, #15b son sintéticos por construcción; el
runner verifica shape + invariantes contra el response real (status,
external_dispatch_status, números, IVA), pero los valores cents
individuales del fixture son ilustrativos. Las invariantes aritméticas
chequeables (§17) se validan con behavior tests sobre escenarios seedeados
deterministicamente.

## Pendientes conocidos / fuera de scope v1

- `POST /invoices/:lago_id/redispatch` (mencionado en D11 como opcional).
- Webhooks salientes hacia clientes Lago-compatible (Lago Cloud los expone
  como `/api/v1/webhooks`; mini-Lago todavía no replica).
- Tabla de retries con backoff para outbound NetSuite — actualmente un
  intento síncrono; si falla queda en `external_dispatch_status: failed`
  y la próxima emisión sale por redispatch manual.
- Soporte de `charge_model` distinto a `standard` (D8 explícitamente lo
  bloquea en v1).
- mTLS real en `/external-confirm`: el código checa que el cliente
  presentó cert si el flag está activo, pero la validación CA-firmado se
  delega al reverse proxy (nginx/Envoy) en producción.
