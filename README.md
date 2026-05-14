# mini-Lago — billing engine para Numaris

![CI](https://github.com/davidbarba-bit/games/actions/workflows/ci.yml/badge.svg)

Motor de facturación domain-specific para **Numaris** (rastreo flotillas en LATAM).
Calcula invoices por uso real + las despacha a NetSuite. Construido v1 contra el
spec `mini-lago-handoff/mini-lago-spec.md`, evolucionado a **v4 Numaris-native**:
un solo invoice por cliente por periodo agregando cargos de todos sus servicios
recurrentes + add-ons, con soporte de servicios one-off (cargo único por unidad)
en dos modos: emisión inmediata por ping o acumulación al cierre del ciclo.

Stack:
- Node 20+ / TypeScript / ES modules.
- Fastify 5 (HTTP) con `fastify-raw-body` para verificar HMAC del callback.
- Prisma 6 sobre PostgreSQL 16.
- Luxon para timezone IANA.
- Vitest para behavior + unit tests.

---

## El modelo de dominio (v4)

El cambio mental crítico: **un cliente recibe UNA factura por periodo** que cubre
TODO lo que le facturas (todos sus servicios recurrentes contratados + sus
add-ons a nivel cliente). Adicionalmente puede recibir facturas individuales
por servicios one-off cuando está configurado en modo `immediate`.

```
Organization (Numaris)
   └── Customer (cada cliente final: "Carga Express MX", "Transportes Norte", ...)
         │   ├── billing_period_months: 1 | 3 | 6 | 12   ← intervalo del ciclo
         │   ├── billing_anchor_day: 1..28              ← día de cierre del periodo
         │   ├── nonrecurring_trigger: immediate | next_cycle  ← cómo facturar one-offs
         │   ├── subscription_at, current_billing_period_started_at / _ending_at
         │   └── status: pending | active | terminated
         │
         ├── Service[]          ← cada producto contratado por el cliente
         │     ├── pricing_model: recurring | one_off
         │     ├── monthly_unit_amount_cents   (recurring: por periodo / one_off: cargo único)
         │     ├── setup_unit_amount_cents     (sólo recurring; 0 en one_off)
         │     ├── status: active | terminated
         │     ├── Unit[]       ← cada cosa rastreada (camión, GPS, etc.)
         │     │     ├── external_id, label
         │     │     ├── active_from, active_to    ← define el prorrateo recurring
         │     │     ├── setup_billed_at           ← gate del setup fee (recurring)
         │     │     └── oneoff_billed_at          ← gate del cobro one_off
         │     └── ServiceAddOn[]               ← modifier per-unit (solo recurring)
         │           ├── amount_cents (por unidad por periodo)
         │           ├── active_from, active_to
         │           └── ej. "Historial 12 meses +$50/u/periodo"
         │
         └── CustomerAddOn[]    ← modifier flat (NO depende de units o services)
               ├── amount_cents (flat por periodo)
               ├── active_from, active_to
               └── ej. "10 reglas de evento +$1000/periodo"

   └── Tax[]                    ← IVA MX 16% — se aplica al total de cada invoice
```

### Cómo se factura

Hay **dos flujos de invoice** distintos:

**A. Cycle invoice — POST /api/v1/invoices**

Recibe `customer_external_id`. Calcula el periodo vigente del customer
(según `billing_period_months` + `billing_anchor_day`, con prorrateo del primer
periodo "stub" si subscription_at no cae en el anchor).

Para ese customer + periodo:
1. **Por cada Service `recurring` activo del customer:**
   - 1 fee `monthly` (per-unit prorrateado por cada unidad activa en el periodo).
   - 1 fee `setup` (por cada unidad con `setup_billed_at = null`; luego marca billed).
   - 1 fee `service_addon` por cada ServiceAddOn vigente (per-unit prorrateado).
2. **Por cada Service `one_off` activo, si `customer.nonrecurring_trigger == 'next_cycle'`:**
   - 1 fee `one_off` con todas las units cuya `oneoff_billed_at = null` y `active_from`
     cayó dentro del periodo. Luego marca billed (no volverán a aparecer).
3. **Por cada CustomerAddOn vigente:** 1 fee `customer_addon` flat (prorrateado).
4. **Taxes**: stack del Customer (IVA MX 16% por default) sobre el subtotal.

**B. One-off immediate invoice — POST /api/v1/events (side-effect)**

Si el evento crea/re-activa una Unit en un Service con `pricing_model='one_off'`
**y** el Customer tiene `nonrecurring_trigger='immediate'` **y** la unit no había
sido cobrada antes (`oneoff_billed_at = null`):
- Se emite automáticamente UNA invoice individual con SOLO esa unit.
- Se marca la unit como cobrada.
- Se despacha a NetSuite en background.
- El response del POST /events incluye `triggered_invoice_id`.

Esto significa que un día con 1000 pings genera 1000 invoices + 1000 dispatches.
Re-pings (re-activaciones) de una unit ya cobrada NO emiten nueva invoice.

Resultado: un invoice con N fees clasificados por `kind ∈ {monthly, setup, service_addon, customer_addon}`, su `units_annex` consolidado y los `applied_taxes`.

### Ejemplo real (escenario seed Numaris)

```
Customer: Carga Express MX (intervalo 1M, anchor día 1, trigger next_cycle, IVA 16%)
  ├── Service recurring: Combustible Carga Express ($450/u/mes + setup $1200/u)
  │     ├── Unit Camión 001  (todo el mes)
  │     ├── Unit Camión 002  (entra día 12, setup pendiente)
  │     ├── Unit Camión 003  (sale día 30, setup ya cobrado)
  │     └── ServiceAddOn: Historial 12m  (+$50/u/mes)
  ├── Service one_off: Instalación inicial GPS ($3500/u, sin recurrencia)
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

Si el customer fuera `nonrecurring_trigger='immediate'`, cada nueva unit del
service "Instalación GPS" emitiría su propia invoice de $3500 + IVA al
momento del ping. En modo `next_cycle` (default), las units de ese service
se acumulan y salen como un fee `one_off` adicional en la próxima cycle invoice.

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

**2. Crear el customer** (vía API hoy — el form admin todavía no existe)
```bash
curl -X POST $HOST/api/v1/customers \
  -H 'Authorization: Bearer $API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"customer": {
    "external_id":            "transportes-norte",
    "name":                   "Transportes del Norte SA",
    "currency":               "MXN",
    "timezone":               "America/Monterrey",
    "tax_identification_number": "TNS250101AAA",
    "billing_period_months":  3,                   // 1 | 3 | 6 | 12
    "billing_anchor_day":     1,                   // 1..28 — día de cierre
    "nonrecurring_trigger":   "next_cycle",        // immediate | next_cycle
    "subscription_at":        "2026-06-01T00:00:00Z",
    "tax_codes":              ["iva-mx-16"]
  }}'
```
- `billing_period_months` = largo del ciclo (3 = trimestral).
- `billing_anchor_day` = día del mes en que cierra (1 = día 1 de mes).
- `nonrecurring_trigger` = cómo se facturan units de services one-off:
  `immediate` (1 invoice por ping) o `next_cycle` (acumular hasta cierre).
- Si `subscription_at` es futuro → status `pending` (cron lo activa al llegar la fecha).
- Si `subscription_at` no cae en `billing_anchor_day`, el primer periodo es un
  stub corto desde `subscription_at` hasta el próximo anchor (con prorrateo).

**3. Crear el / los services del customer**

Service RECURRENTE (renta por periodo):
```
/admin/services → "+ Nuevo service"
  customer_external_id:       transportes-norte
  code:                       combustible-transportes-norte
  name:                       "Servicio Combustible"
  pricing_model:              recurring
  monthly_unit_amount_cents:  45000        ← $450 / unidad / periodo (1 mes, 3M, 6M, 12M según customer)
  setup_unit_amount_cents:    120000       ← $1200 / unidad one-off al primer ping
  tax_codes:                  []           ← vacío = hereda los del customer
```

Service ONE-OFF (cargo único por unidad cuando aparece):
```
/admin/services → "+ Nuevo service"
  customer_external_id:       transportes-norte
  code:                       instalacion-gps-transportes-norte
  name:                       "Instalación GPS"
  pricing_model:              one_off
  monthly_unit_amount_cents:  350000       ← $3500 cargo único por unidad
  setup_unit_amount_cents:    0            ← debe ser 0 en one_off
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
- `POST /api/v1/customers` — upsert por `external_id`. Acepta `billing_period_months` (1/3/6/12), `billing_anchor_day` (1-28), `nonrecurring_trigger` (immediate | next_cycle), `subscription_at`.
- `GET /api/v1/customers` (paginado), `GET /api/v1/customers/:external_id`
- `DELETE /api/v1/customers/:external_id` (409 si tiene services activos)

### Services
- `POST /api/v1/services` — alta atada a un customer. Acepta `pricing_model` (recurring | one_off). En one_off, `setup_unit_amount_cents` debe ser 0 y `monthly_unit_amount_cents` > 0.
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
- `POST /api/v1/events` — add/remove (materializa unit + audit). **Side-effect v4**: si la unit pertenece a un service `one_off` y el customer tiene `nonrecurring_trigger='immediate'`, emite invoice individual + dispatch a NetSuite. El response incluye `triggered_invoice_id`.
- `GET /api/v1/events` — audit log
- `POST / GET / PATCH /api/v1/units[/:id]` — CRUD directo

### Taxes
- `POST /api/v1/taxes`, `GET /api/v1/taxes`, `GET /api/v1/taxes/:code`

### Invoices
- `POST /api/v1/invoices` — cycle invoice del customer. `{ customer_external_id, period_from?, period_to?, metadata: { idempotency_key } }`. Agrega fees de services recurring + one_offs en modo next_cycle + customer add-ons.
- One-off **immediate** invoices: no se crean por este endpoint — se emiten automáticamente vía `POST /api/v1/events` (1 por ping).
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
- `tests/behavior/v4-intervals-oneoff.test.ts` — 7 casos v4: intervalo 3M, stub primer periodo, one_off + next_cycle (acumula y marca billed), one_off + immediate (emite invoice individual desde /events), re-ping no duplica, validaciones (setup>0 en one_off, intervalo fuera de {1,3,6,12}).
- `tests/behavior/v3-billing.test.ts` — 3 casos del modelo v3 base (seed completo, customer add-on independiente de units, terminated add-on excluido).
- `tests/behavior/admin-reset.test.ts` — 6 casos del hard-reset (preserva org, resetea counters, sequential_ids arrancan en 1).
- `tests/unit/*` — rounding, tz, HMAC.

29/29 verde en la última ejecución.

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
- `20260514_v4_intervals_and_oneoff` — v4: drop `billing_time`. Customer gana `billing_period_months` (1/3/6/12), `billing_anchor_day` (1-28), `nonrecurring_trigger`. Service gana `pricing_model` (recurring/one_off). Unit gana `oneoff_billed_at`. Fee.kind gana `one_off`.

Cada migración es destructiva sobre la anterior. En prod, después de aplicar v4 ejecuta el **Hard reset** desde el admin y re-seedea para tener data limpia.
