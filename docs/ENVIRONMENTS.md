# Ambientes — staging y producción

Numaris Billing corre en dos deployments separados:

| Ambiente | Subdominio (sugerido) | Para qué | Estado |
|---|---|---|---|
| **Staging** | `billing.numaris.com` (el deployment actual) | Pruebas, demos internas, integración de devs | Ya existe |
| **Producción** | `billing.numaris.com` o `app.billing.numaris.com` (a definir) | CFDIs reales, NetSuite productivo | **Por crear** |

> El deployment actual nació con datos de pruebas mezclados y la API key default del seed (`dev-api-key-replace-me`). Por eso lo reclasificamos como **staging** y producción se levanta limpio desde cero — no se migran datos.

## Aislamiento

Cada ambiente tiene **su propia base de datos PostgreSQL** y **su propio cron de cycle billing**. No comparten nada. Eso significa:

- Un cliente en staging NO aparece en prod ni viceversa.
- El cron de prod cierra ciclos de prod; el de staging cierra ciclos de staging.
- El dispatcher de prod va al **NetSuite productivo**; el de staging va al **sandbox de NetSuite** (o queda desactivado con `FEATURE_NETSUITE_DISPATCH_ENABLED=false`).
- Cada uno tiene **su propia API key**. Un dev probando en staging no puede tocar prod por error.

## Crear el deployment de producción (paso a paso)

### 1. Railway: nuevo project

1. Crea un nuevo Railway project: `numaris-billing-prod`.
2. Adjunta una **base de datos Postgres** nueva (no reutilices la de staging).
3. Conecta el mismo repo `davidbarba-bit/billing2`, branch `main` (o el que sea tu rama de release).
4. **No despliegues aún** — primero configura las variables de entorno.

### 2. Variables de entorno

Configura estas en el nuevo project de Railway. Las marcadas **(distintas a staging)** son las que NO debes copiar tal cual del actual:

```bash
# Base de datos — la asigna Railway automáticamente al adjuntar Postgres.
DATABASE_URL=postgresql://...

# (distintas a staging) Identidad del ambiente.
NODE_ENV=production
SEED_DEFAULT_ORG_SLUG=NUM-PROD
SEED_DEFAULT_ORG_TIMEZONE=America/Mexico_City

# (distintas a staging) API key inicial — usa una pre-generada y luego rótala
# (ver paso 4). El valor default 'dev-api-key-replace-me' es INSEGURO.
SEED_DEFAULT_API_KEY=PROD-temporal-rotar-despues-del-primer-boot

# Callback URL pública (con el dominio que vas a usar en prod).
CALLBACK_BASE_URL=https://billing.numaris.com

# (distintas a staging) NetSuite — apunta al ambiente PRODUCTIVO.
FEATURE_NETSUITE_DISPATCH_ENABLED=true
NETSUITE_ACCOUNT_ID=...
NETSUITE_CONSUMER_KEY=...
NETSUITE_CONSUMER_SECRET=...
NETSUITE_TOKEN_KEY=...
NETSUITE_TOKEN_SECRET=...
NETSUITE_REST_BASE=https://<account>.suitetalk.api.netsuite.com

# Admin UI — Google OAuth (mismo proyecto OAuth está bien; el dominio
# allowed sí se mantiene).
ADMIN_AUTH_MODE=google
GOOGLE_OAUTH_CLIENT_ID=<igual que staging si reusas el OAuth client>
GOOGLE_OAUTH_CLIENT_SECRET=<igual>
ADMIN_ALLOWED_EMAIL_DOMAIN=numaris.com
SESSION_SECRET=<32+ chars random, distinto a staging>

# (distintas a staging) Admin reset — si la habilitas, usa un token único
# por ambiente. Mejor déjala SIN setear en prod (deshabilita el endpoint).
# ADMIN_RESET_TOKEN=<no setear en prod a menos que tengas un caso claro>
```

### 3. Primer despliegue + migraciones

Railway corre `npm start` que hace `prisma migrate deploy && node dist/server.js`. Al primer arranque:
1. Aplica todas las migraciones.
2. `ensureDefaultOrganization` crea la organización default con la `SEED_DEFAULT_API_KEY` que pusiste (la temporal del paso 2).

Verifica que arrancó bien — `GET https://billing.numaris.com/health` debe responder `{ status: "ok" }`.

### 4. Rotar la API key de producción a una segura

La key temporal del paso 2 quedó en el dashboard de Railway (en plaintext) — eso ya no es seguro. Rotala YA por una key generada criptográficamente:

```bash
# Desde tu máquina, conectándote a la BD de prod (DATABASE_URL del project):
DATABASE_URL='postgresql://<conn-string-de-prod>' \
  npm run bootstrap-org -- --slug NUM-PROD --rotate-key
```

El script imprime la key nueva UNA VEZ por stdout. Copiala a un gestor de secretos (1Password / Bitwarden) y bórrala de la terminal.

Después:
1. **Borra `SEED_DEFAULT_API_KEY` de las env vars de Railway** (ya no se usa una vez que la org existe — `ensureDefaultOrganization` solo crea si `count === 0`).
2. Esa key nueva es la que les pasas a los developers que integren contra prod.

### 5. Dominio

En Railway → Settings → Domains, asigna el dominio que quieras a este nuevo project. Tienes dos opciones:

- **A. Mover `billing.numaris.com` al nuevo project**: el dominio limpio queda para prod. Los devs externos no tienen que cambiar nada cuando saquemos staging del aire o lo separemos.
  - Hay que cambiar al staging actual a otro subdominio (ej. `staging.billing.numaris.com`) **antes** de hacer el switch, o tendrás un momento sin staging mientras DNS propaga.
- **B. Dejar staging en `billing.numaris.com` y prod en `app.billing.numaris.com`** (u otro). Más simple operacionalmente porque no tocas DNS de staging.

**Mi recomendación: A.** Producción merece la URL canónica. Los devs externos solo verán `billing.numaris.com` en la documentación.

### 6. Rotar la API key de STAGING

Aprovecha que estás creando prod limpio para rotar también la de staging — hoy probablemente sigue siendo la default `dev-api-key-replace-me`, que está en el repo público:

```bash
# Conectado a la BD de staging:
DATABASE_URL='postgresql://<conn-string-de-staging>' \
  npm run bootstrap-org -- --slug NUM-FC2D --rotate-key --name "Numaris (staging)"
```

(El slug actual `NUM-FC2D` es el del seed default. Si quieres renombrarlo a `NUM-STAGING` para que sea obvio, hazlo en otro paso vía SQL — el script `bootstrap-org` no cambia slug porque es la clave de búsqueda.)

## Comprobaciones de seguridad para producción

Antes de darle la URL y la key a los developers de Numaris:

- [ ] `SEED_DEFAULT_API_KEY` borrada de las env vars (o al menos con un valor inútil — ya no se lee después del primer boot).
- [ ] `ADMIN_RESET_TOKEN` NO seteado (o detrás de un token random fuerte si lo necesitas).
- [ ] `NETSUITE_*` apuntan al ambiente productivo de NetSuite (NO al sandbox).
- [ ] `FEATURE_NETSUITE_DISPATCH_ENABLED=true`.
- [ ] `CALLBACK_BASE_URL` coincide con el dominio público real de prod.
- [ ] `SESSION_SECRET` ≥ 32 chars y distinto al de staging.
- [ ] `netsuiteCallbackSecret` de la organización (lo imprime `bootstrap-org` al crearla) compartido con el equipo de NetSuite para que firmen los callbacks.

## ¿Cómo se crean / rotan organizaciones después?

Usa el mismo script:

```bash
# Crear una nueva organización en cualquier ambiente:
DATABASE_URL='...' npm run bootstrap-org -- \
  --slug NUM-SANDBOX-DEV1 \
  --name "Sandbox de Juan" \
  --timezone America/Mexico_City

# Rotar la key de una organización existente:
DATABASE_URL='...' npm run bootstrap-org -- --slug NUM-PROD --rotate-key
```

El script imprime la API key y el `netsuite_callback_secret` UNA VEZ — son los valores que tienes que guardar en tu gestor de secretos.
