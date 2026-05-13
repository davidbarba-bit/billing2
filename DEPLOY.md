# Deploy a Railway

mini-Lago corre como un único servicio Node + Postgres en Railway. El
build usa el `Dockerfile` del repo (multi-stage Node 20 Alpine) y la
migración Prisma se aplica al iniciar (`CMD ["sh", "-c", "npx prisma
migrate deploy && node dist/server.js"]`).

> **Nota sobre Nixpacks.** Una versión anterior usaba Nixpacks, pero
> Railway's npm cache mount entra en conflicto con la limpieza de
> `node_modules/.cache` durante el build (`EBUSY: resource busy`). El
> Dockerfile lo evita.

## Prerequisitos

- Cuenta en https://railway.app (free tier alcanza para staging).
- Repo en GitHub vinculado a tu cuenta Railway.

## Pasos

### 1. Crear proyecto + Postgres

1. https://railway.app/new → **Deploy from GitHub repo** → selecciona
   `davidbarba-bit/billing2`.
2. Railway detecta `Dockerfile` (via `railway.toml`) y arranca el build.
3. En el proyecto, click **+ New → Database → Add PostgreSQL**.
4. Railway crea la variable `DATABASE_URL` y la conecta al servicio web
   automáticamente. No necesitas tocarla.

### 2. Variables de entorno

En el servicio web → **Variables → Raw Editor**, pega lo siguiente
**sustituyendo los placeholders** (Railway genera valores secretos si los
dejas en blanco con la sintaxis `${{ shared.NOMBRE }}`):

```
NODE_ENV=production
LOG_LEVEL=info
HOST=0.0.0.0
SEED_DEFAULT_ORG_SLUG=NUM-FC2D
SEED_DEFAULT_ORG_TIMEZONE=America/Mexico_City
SEED_DEFAULT_API_KEY=mlk_<32-bytes-random>
ADMIN_USER=admin
ADMIN_PASSWORD=<24-bytes-random>
ADMIN_RESET_TOKEN=<32-bytes-random>
FEATURE_NETSUITE_DISPATCH_ENABLED=false
FEATURE_NETSUITE_CALLBACK_MTLS=false
NETSUITE_CALLBACK_IP_ALLOWLIST=
PERIOD_ROLLOVER_ENABLED=true
```

`ADMIN_RESET_TOKEN` habilita `POST /api/v1/admin/reset` (hard wipe de la
org autenticada). Si lo dejas en blanco, el endpoint responde 403
`admin_reset_disabled` — útil en prod donde no quieres exponerlo.

> `PORT` y `DATABASE_URL` los inyecta Railway automáticamente. **No** los
> seteés a mano.

Generar valores aleatorios localmente:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

### 3. Exponer el servicio

En **Settings → Networking** del servicio web:

- Click **Generate Domain** — Railway te da una URL del estilo
  `https://billing2-production-xxxx.up.railway.app` con HTTPS válido.
- Opcional: añade tu dominio custom y crea el CNAME que Railway sugiere.

### 4. Verificar

```bash
# Reemplaza con tu URL real.
URL=https://billing2-production-xxxx.up.railway.app

curl -s $URL/health
# { "status": "ok" }

# La API espera Bearer <SEED_DEFAULT_API_KEY>.
curl -s -X POST $URL/api/v1/taxes \
  -H "Authorization: Bearer $SEED_DEFAULT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tax":{"name":"IVA","code":"iva-mx-16","rate":"16"}}'

# Admin (HTTP Basic Auth ADMIN_USER/ADMIN_PASSWORD).
open $URL/admin
```

### 5. Seed Numaris en producción

Una vez logueado al admin:

1. Dashboard → **Seed Numaris (3 camiones)**.
2. Customers → carga-express-mx → ves el escenario completo.
3. Invoices → **+ Nueva invoice** → genera la factura con prorrateo.
4. En el detalle → **Simular folio NetSuite** → la invoice pasa a
   `finalized + confirmed`.

## Auto-deploy

Cada push a `main` dispara un build + deploy automático. Railway aplica
las migraciones Prisma (`prisma migrate deploy`) antes de arrancar el
server, así que cambios de schema pasan sin downtime mientras sean
aditivos.

## Logs

- Railway → servicio web → **Logs** muestra stdout/stderr en vivo.
- pino emite JSON cuando `NODE_ENV=production` (sin pino-pretty), lo que
  hace fácil filtrar por `level`, `code`, `req.id`.

## Costos esperados (Hobby plan)

- Servicio web: ~$5–7/mes para uso constante (alcanza con 512MB RAM).
- Postgres: ~$5/mes para 1GB.
- Total: ~$10–12/mes. El free trial ($5 crédito mensual) alcanza para
  staging intermitente.

## Pendientes para producción real

- Reemplazar `SEED_DEFAULT_API_KEY` por API keys per-customer si vas a
  exponer la API a múltiples clientes (hoy es per-organization, una org
  por deploy).
- Configurar `NETSUITE_*` env vars y `FEATURE_NETSUITE_DISPATCH_ENABLED=true`
  cuando tengas credenciales TBA reales.
- Configurar `NETSUITE_CALLBACK_IP_ALLOWLIST` con los rangos publicados
  por NetSuite (D12, capa 3).
- Backups automáticos de Postgres: Railway → Database → **Backups → Enable
  daily snapshots**.

## Rollback

```bash
# Desde la UI: Deployments → click un deploy anterior → Redeploy
# Desde CLI:
railway redeploy --service web --deployment <deployment-id>
```
