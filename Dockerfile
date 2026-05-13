# Multi-stage Docker build for Railway / any container platform.
#
# Stage 1 (builder): install full deps, generate Prisma client, compile TS.
# Stage 2 (runtime):  install only prod deps, copy dist + prisma artefacts.

FROM node:20-alpine AS builder
WORKDIR /app

# OpenSSL is required by the Prisma engine on Alpine.
RUN apk add --no-cache openssl

# Install all deps (including dev) so we can run `tsc`.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Generate the Prisma client + compile TypeScript.
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------------

FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Bring in the prisma schema + the generated client + the compiled JS +
# the OpenAPI contract served at /openapi.json /docs.
COPY prisma ./prisma
COPY docs ./docs
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# Railway injects PORT at runtime; default to 3000 locally.
ENV PORT=3000
EXPOSE 3000

# Apply pending migrations then boot. Migrations are no-ops on a clean DB.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
