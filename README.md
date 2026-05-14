# mini-Lago — billing engine para Numaris

![CI](https://github.com/davidbarba-bit/games/actions/workflows/ci.yml/badge.svg)

Motor de facturación domain-specific para **Numaris** (rastreo flotillas en LATAM).
Calcula invoices por uso real + las despacha a NetSuite. Construido v1 contra el
spec `mini-lago-handoff/mini-lago-spec.md`, evolucionado a **v3 Numaris-native**
para reflejar cómo realmente se factura (un solo invoice por cliente por
periodo, agregando cargos de todos sus servicios + add-ons).

Stack:
- Node 20+ / TypeScript / ES modules.
- Fastify 5 (HTTP) con `fastify-raw-body` para verificar HMAC del callback.
- Prisma 6 sobre PostgreSQL 16.
- Luxon para timezone IANA.
- Vitest para behavior + unit tests.

---

## El modelo de dominio (v3)

El cambio mental crítico: **un cliente recibe UNA factura al mes** que cubre
TODO lo que le facturas (todos sus servicios contratados + sus add-ons a nivel
cliente), no una factura por servicio. Esto se modela así:

```
Organization (Numaris)
   └── Customer (cada cliente final: "Carga Express MX", "Transportes Norte", ...)
         │   ├── billing_time:  calendar | anniversary   ← el ciclo es del CLIENTE
         │   ├── subscription_at, current_billing_period_started_at / _ending_at
         │   └── status: pending | active | terminated
         │
         ├── Service[]          ← cada producto contratado por el cliente
         │     ├── monthly_unit_amount_cents   (ej. $450/u/mes)
         │     ├── setup_unit_amount_cents     (ej. $1200/u one-off)
         │     ├── status: active | terminated
         │     ├── Unit[]       ← cada cosa rastreada (camión, GPS, etc.)
         │     │     ├── external_id, label
         │     │     ├── active_from, active_to    ← define el prorrateo
         │     │     └── setup_billed_at           ← gate del setup fee
         │     └── ServiceAddOn[]               ← modifier per-unit
         │           ├── amount_cents (por unidad por mes)
         │           ├── active_from, active_to
         │           └── ej. "Historial 12 meses +$50/u/mes"
         │
         └── CustomerAddOn[]    ← modifier flat (NO depende de units o services)
               ├── amount_cents (flat por mes)
               ├── active_from, active_to
               └── ej. "10 reglas de evento +$1000/mes"

   └── Tax[]                    ← IVA MX 16% — se aplica al total del invoice
```

### Cómo se calcula un invoice (POST /api/v1/invoices)

Recibe un `customer_external_id` y opcionalmente un periodo override. Si no
recibe periodo, usa el periodo vigente del customer.

Para ese customer + periodo:
1. **Por cada Service activo del customer:**
   - 1 fee `monthly` (suma del per-unit mensual prorrateado por cada unidad activa).
   - 1 fee `setup` (por cada unidad con `setup_billed_at = null` se cobra el setup, luego se marca como cobrado).
   - 1 fee `service_addon` por cada ServiceAddOn vigente (per-unit prorrateado).
2. **Por cada CustomerAddOn vigente:** 1 fee `customer_addon` flat (prorrateado solo si el add-on inició a mitad del periodo).
3. **Taxes**: se aplica el stack de taxes del Customer (IVA MX 16% por default) sobre el subtotal.

Resultado: un invoice con N fees clasificados por `kind ∈ {monthly, setup, service_addon, customer_addon}`, su `units_annex` consolidado y los `applied_taxes`.

### Ejemplo real (escenario seed Numaris)

```
Customer: Carga Express MX  (calendar, IVA 16%)
  └── Service: Combustible Carga Express ($450/u/mes + setup $1200/u)
        ├── Unit Camión 001  (todo el mes)
        ├── Unit Camión 002  (entra día 12, setup pendiente)
        ├── Unit Camión 003  (sale día 30, setup ya cobrado)
        └── ServiceAddOn: Historial 12m  (+$50/u/mes)
  └── CustomerAddOn: Reglas 10  ($1000/mes flat)

POST /api/v1/invoices {customer_external_id: "carga-express-mx"}
  → 4 fees:
     monthly         116127   (3 camiones prorrateados × $450)
     setup           120000   (Camión 002 × $1200)
     service_addon    12903   (Historial 12m: $50 × 3 prorrateados)
     customer_addon  100000   (Reglas 10: $1000 flat)
     ─────────────────────
     fees           349030
     IVA 16%         55845
     total          404875
```

---

## El back-office (`/admin`)

`http://localhost:3000/admin` (o tu host Railway) protegido con HTTP Basic Auth
(`ADMIN_USER` / `ADMIN_PASSWORD`, default `admin`/`admin`).

Es la consola operativa para que el equipo de Numaris dé de alta y administre
todo sin tocar la API directamente. Es server-rendered (Tailwind via CDN, no
build step) — funciona en cualquier browser.

### Mapa de secciones

| Sección | Qué hace |
|---|---|
| `/admin` (dashboard) | Counts por entidad + botones **Seed Numaris** y **Hard reset** (preserva la organización, wipea data) |
| `/admin/taxes` | Lista + crear taxes (ej. IVA MX 16%). Cada tax tiene `code`, `name`, `rate`. |
| `/admin/customers` | Lista + alta de customers. La alta pide los datos fiscales + **billing_time** (calendar/anniversary) + **subscription_at**. |
| `/admin/customers/:ext` | Detalle del customer con todas sus relaciones. Es el panel central de operación (ver abajo). |
| `/admin/services` | Lista + alta de services. Cada service va atado a un customer y define los montos `monthly` y `setup` por unidad. |
| `/admin/services/:code` | Detalle del service: units, ServiceAddOns per-unit, link al customer. |
| `/admin/invoices` | Lista paginada de invoices con su periodo, status, dispatch status y total. |
| `/admin/invoices/:id` | Detalle del invoice con fees + `billed_units_detail` expandido + applied_taxes. Botones: **void** y **simular folio NetSuite** (firma HMAC + POST a `/external-confirm`). |
| `/admin/credit-notes` | Lista + detalle de CNs + botón simular folio CN. |
| `/admin/events` | Stream del audit log (últimos 200 eventos add/remove de units). |

### Flujo de alta paso a paso

Así es como un operador de Numaris da de alta un nuevo cliente y empieza a
facturarle:

**1. Crear el tax (una sola vez por organización)**
```
/admin/taxes → "+ Nuevo tax"
  code: iva-mx-16   name: "IVA México"   rate: 16
```

**2. Crear el customer**
```
/admin/customers → "+ Nuevo customer"
  external_id:       transportes-norte
  name:              "Transportes del Norte SA"
  currency:          MXN
  timezone:          America/Monterrey
  tax_identification_number: TNS250101AAA
  billing_time:      calendar               ← cobra el 1° del mes
  subscription_at:   2026-06-01T00:00:00Z   ← fecha de arranque
  tax_codes:         [iva-mx-16]
```
Si `subscription_at` es futuro → status `pending` y el cron lo activará automáticamente al llegar la fecha. Si es presente/pasado → status `active` desde el día 1.

**3. Crear el / los services del customer**
```
/admin/services → "+ Nuevo service"
  code:                       combustible-transportes-norte
  customer_external_id:       transportes-norte
  name:                       "Servicio Combustible"
  currency:                   MXN
  monthly_unit_amount_cents:  45000        ← $450 / unidad / mes
  setup_unit_amount_cents:    120000       ← $1200 / unidad one-off
  tax_codes:                  []           ← vacío = hereda los del customer
```

**4. Agregar las units (los camiones, los GPS, lo que rastrees)**

Hay dos vías:
- **API event-driven**: POST `/api/v1/events` con `operation_type=add` materializa la unit + deja audit log. Es la vía que usaría la integración real.
- **API directa**: POST `/api/v1/units` para alta manual.

Ambas convergen al mismo `Unit` materializado con `active_from` (= timestamp del evento).

**5. (Opcional) Add-ons**

Desde el detalle del service o del customer:
- **ServiceAddOn (per-unit)** — `/admin/services/:code` → "+ Agregar add-on per-unit". Ej. "Historial 12 meses +$50/u/mes". Se cobra sobre las units activas del service.
- **CustomerAddOn (flat)** — `/admin/customers/:ext` → "+ Agregar customer add-on (flat)". Ej. "10 reglas de evento +$1000/mes". Se cobra una sola vez sin importar units ni services.

Estos add-ons tienen su propio `active_from` / `active_to` para que se puedan
activar a mitad de mes (y se prorratean) y dar de baja sin afectar histórico.

**6. Emitir el invoice del periodo**
```
/admin/customers/transportes-norte → botón "Calcular factura del periodo"
```
Esto invoca `POST /api/v1/invoices` con el customer y muestra el invoice
calculado. Si el feature flag de NetSuite está prendido, intenta despachar
automáticamente y queda en `external_dispatch_status: dispatched`. Si no, queda
en `pending`.

**7. Confirmar el folio NetSuite (en producción esto lo hace NetSuite via webhook)**

Para probar local, desde el detalle del invoice click **"Simular folio NetSuite"**.
Internamente firma con HMAC válido y hace POST a `/external-confirm` — el
invoice pasa a `finalized` + `confirmed` y queda visible el folio fiscal.

### Hard reset (preserva organización, wipea data)

El dashboard tiene un botón rojo **"Hard reset"** que pide tipear el slug de la
organización como confirmación. Borra TODOS los customers, services, units,
events, invoices y credit notes, pero **mantiene la organización con su API
key, sus credenciales NetSuite y los counters reseteados a 0**.

Útil para vaciar la DB de prod después de pruebas, sin perder la auth. También
expuesto por API: `POST /api/v1/admin/reset` con header `X-Admin-Reset-Token`
y body `{confirm: "<org-slug>"}`.

---

## Contrato público (OpenAPI)

La API expone su contrato sin auth en tres formas:
- **`GET /openapi.json`** — OpenAPI 3.1 completo (25 paths, 17 schemas).
- **`GET /docs`** — Swagger UI navegable.
- **`GET /api/v1`** — discovery JSON liviano (método + path + summary).

Apunta tu generador de cliente a `https://<host>/openapi.json`.

---

## Endpoints

### Customers
- `POST /api/v1/customers` — upsert por `external_id` (acepta `billing_time`, `subscription_at`)
- `GET /api/v1/customers` (paginado), `GET /api/v1/customers/:external_id`
- `DELETE /api/v1/customers/:external_id` (409 si tiene services activos)

### Services
- `POST /api/v1/services` — alta atada a un customer (sin billing fields, se heredan)
- `GET /api/v1/services` (filtros `customer_external_id`, `status`), `GET /api/v1/services/:code`
- `POST /api/v1/services/:code/terminate` — marca terminated + cierra units activas
- `DELETE /api/v1/services/:code` (409 si tiene fees emitidas)

### Service add-ons (per-unit, scope = service)
- `POST /api/v1/services/:code/add-ons` — crear
- `GET /api/v1/services/:code/add-ons` — listar
- `GET / PATCH / DELETE /api/v1/service-add-ons/:id` — leer / editar / soft-terminate

### Customer add-ons (flat, scope = customer)
- `POST /api/v1/customers/:ext/add-ons` — crear
- `GET /api/v1/customers/:ext/add-ons` — listar
- `GET / PATCH / DELETE /api/v1/customer-add-ons/:id`

### Units & events
- `POST /api/v1/events` — add/remove (materializa unit + audit)
- `GET /api/v1/events` — audit log
- `POST / GET / PATCH /api/v1/units[/:id]` — CRUD directo

### Taxes
- `POST /api/v1/taxes`, `GET /api/v1/taxes`, `GET /api/v1/taxes/:code`

### Invoices (per customer per period)
- `POST /api/v1/invoices` — `{ customer_external_id, period_from?, period_to?, metadata: { idempotency_key } }`
- `GET /api/v1/invoices` (filtros `customer_external_id`, `status`), `GET /api/v1/invoices/:id`
- `POST /api/v1/invoices/:id/void`
- `POST /api/v1/invoices/:id/external-confirm` — callback NetSuite (HMAC)

### Credit notes
- `POST /api/v1/credit_notes` — la invoice debe estar `finalized` + `confirmed`
- `GET /api/v1/credit_notes`, `GET /api/v1/credit_notes/:id`
- `POST /api/v1/credit_notes/:id/external-confirm`

### Admin
- `POST /api/v1/admin/reset` — wipe data preservando organización (requiere `X-Admin-Reset-Token`)

---

## Invariantes que sobreviven de v1

Las decisiones del spec original que siguen vigentes:

- **Timezone IANA** por org + customer; `applicable_timezone` resuelto. Cierres en la tz aplicable (ej. `2026-06-01T05:59:59Z` para CDMX).
- **Idempotencia** en POST /invoices y /credit_notes con header `Idempotency-Key` + `metadata.idempotency_key`. 4 casos cubiertos (mismo body / body distinto / mismatch / ausente).
- **NetSuite outbound** con OAuth 1.0a/TBA HMAC-SHA256, detrás del feature flag `FEATURE_NETSUITE_DISPATCH_ENABLED`.
- **Callback `/external-confirm`** autentica con HMAC-SHA256 timing-safe (`X-NetSuite-Signature`). Fail-closed sin secret. Idempotente por `(invoice_id, folio)`; folio distinto → `409 conflict_folio_changed`.
- **Anexo de unidades** en dos niveles: `fee.billed_units_detail[]` y `invoice.units_annex[]`. `billed_fraction` = string decimal de 4 dígitos. Residuo asignado a la unidad con mayor fracción.
- **Cron** sólo hace roll-over de periodos; nunca emite invoices automáticamente.
- **PUT `/api/v1/customers/:external_id`** responde `404 resource_not_found`.

---

## Setup local

Requiere Postgres en `localhost:5432`. Con Docker:

```
docker compose up -d postgres
cp .env.example .env
DATABASE_URL='postgresql://minilago:minilago@localhost:5432/minilago?schema=public' \
  npx prisma migrate deploy
npm run dev
```

Sin Docker (Ubuntu/Debian):

```
sudo service postgresql start
sudo -u postgres psql -c "CREATE USER minilago WITH PASSWORD 'minilago' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE minilago OWNER minilago;"
sudo -u postgres psql -c "CREATE DATABASE minilago_test OWNER minilago;"
cp .env.example .env
DATABASE_URL='postgresql://minilago:minilago@localhost:5432/minilago?schema=public' \
  npx prisma migrate deploy
DATABASE_URL='postgresql://minilago:minilago@localhost:5432/minilago_test?schema=public' \
  npx prisma migrate deploy
npm run dev
```

Smoke test:
```
curl -s http://localhost:3000/health
# {"status":"ok"}

curl -s -X POST -u admin:admin http://localhost:3000/admin/seed
# Crea el escenario Numaris completo (customer + service + 3 units + add-ons)

curl -s -X POST http://localhost:3000/api/v1/invoices \
  -H 'Authorization: Bearer dev-api-key-replace-me' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: smoke-1' \
  -d '{"invoice":{"customer_external_id":"carga-express-mx","metadata":{"idempotency_key":"smoke-1"}}}' \
  | jq '.invoice | {fees: .fees | map({kind, amount_cents}), total_amount_cents}'
```

---

## Tests

```
npm test               # behavior + unit + helpers
npm run typecheck
```

Suite actual:
- `tests/behavior/v3-billing.test.ts` — 3 casos del modelo v3 (seed completo, customer add-on independiente de units, terminated add-on excluido).
- `tests/behavior/admin-reset.test.ts` — 6 casos del hard-reset (preserva org, resetea counters, sequential_ids arrancan en 1).
- `tests/unit/*` — rounding, tz, HMAC.

22/22 verde en la última ejecución.

---

## CI

Workflow en `.github/workflows/ci.yml` corre en cada push y PR:
- **Job `test`** — Postgres 16 como service container, `prisma migrate deploy`, typecheck + 22 tests.
- **Job `build`** — smoke-test del `Dockerfile` (build sin push) con cache de capas vía GitHub Actions.

Tiempo total ~2 min. Costo: 0 en repos públicos.

---

## Variables de entorno relevantes

| Var | Default | Para qué |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `PORT` | 3000 | Puerto Fastify |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin` | Basic auth del back-office |
| `SEED_DEFAULT_API_KEY` | `dev-api-key-replace-me` | API key sembrada en bootstrap |
| `ADMIN_RESET_TOKEN` | — (requerido para reset) | Token del endpoint `/api/v1/admin/reset` |
| `FEATURE_NETSUITE_DISPATCH_ENABLED` | `false` | Si `true`, despacha invoices a NetSuite |
| `NETSUITE_*` | — | Credenciales OAuth 1.0a / TBA (account_id, consumer_key, consumer_secret, token_key, token_secret, rest_base) |
| `NETSUITE_CALLBACK_SECRET` | — | Shared secret para HMAC del callback |
| `PERIOD_ROLLOVER_ENABLED` | `true` | Si `true`, activa el cron de roll-over de periodos |
| `LOG_LEVEL` | `info` | Pino log level |

---

## Migraciones de schema (historial)

- `20260512_init` — v1 baseline (modelo Lago con plans/subscriptions/billable_metrics).
- `20260513_v2_numaris_native` — v2: drop Lago, modelo Numaris-native (Service con billing fields, AddOn unificado).
- `20260514_v3_customer_invoices` — v3: invoices por Customer, billing fields se mueven a Customer, AddOn se separa en ServiceAddOn + CustomerAddOn.

Cada migración es destructiva sobre la anterior. En prod, después de aplicar v3 ejecuta el **Hard reset** desde el admin y re-seedea para tener data limpia.
