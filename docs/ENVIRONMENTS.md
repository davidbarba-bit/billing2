# Ambiente único

Numaris Billing corre en **un solo deployment** en Railway. Etapa actual: pruebas
e integración inicial con el developer de Numaris. No hay separación
staging/producción todavía.

| Atributo | Valor |
|---|---|
| URL pública | `https://billing.numaris.com` |
| Slug del tenant default | `NUM-FC2D` |
| Documentación de la API (Swagger) | `https://billing.numaris.com/docs` |

## Variables de entorno (Railway)

Las claves relevantes están en el panel del project en Railway. Resumen:

```bash
NODE_ENV=production
DATABASE_URL=postgresql://...                 # asignada por Railway

# Tenant default (lo crea ensureDefaultOrganization al primer boot si la BD
# está vacía).
SEED_DEFAULT_ORG_SLUG=NUM-FC2D
SEED_DEFAULT_ORG_TIMEZONE=America/Mexico_City
SEED_DEFAULT_API_KEY=<la que tengas seteada>

# Callback URL pública (la usa la app para construir URLs absolutas).
CALLBACK_BASE_URL=https://billing.numaris.com

# NetSuite (apaga el dispatcher si todavía no integras).
FEATURE_NETSUITE_DISPATCH_ENABLED=false       # poner true cuando NetSuite esté listo
# NETSUITE_ACCOUNT_ID=...
# NETSUITE_CONSUMER_KEY=...
# NETSUITE_CONSUMER_SECRET=...
# NETSUITE_TOKEN_KEY=...
# NETSUITE_TOKEN_SECRET=...
# NETSUITE_REST_BASE=https://<account>.suitetalk.api.netsuite.com

# Admin UI (Google OAuth).
ADMIN_AUTH_MODE=google
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
ADMIN_ALLOWED_EMAIL_DOMAIN=numaris.com
SESSION_SECRET=<32+ chars random>
```

## Cron de cycle billing

`PERIOD_ROLLOVER_ENABLED=true` (default). Cierra ciclos y dispara los
ejecutores de facturación cada `PERIOD_ROLLOVER_CRON` (default cada 15 min).
Corre en el mismo proceso que la API.

## A futuro: separar ambientes

Si más adelante quieres aislar pruebas de producción real (recomendable cuando
arranque la facturación con dinero real), las piezas a duplicar serían un
Railway project nuevo con su propia BD Postgres y las mismas variables de
entorno con valores propios (API key nueva, credenciales NetSuite productivas,
`SESSION_SECRET` distinto).

Por ahora no hace falta. Todo opera contra `billing.numaris.com`.
