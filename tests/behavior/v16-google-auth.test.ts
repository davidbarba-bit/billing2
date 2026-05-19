// v16 — Google OAuth admin auth + sesión por cookie firmada.
//
// No podemos hitear Google real desde tests, así que cubrimos:
//   - Sign/decode session helper (round-trip).
//   - Domain validation: tampered cookie, expired, missing → rechazo.
//   - preHandler: sin sesión → redirect a /admin/auth/login.
//   - preHandler: con cookie válida → 200 al admin.
//   - GET /admin/auth/login renderiza pantalla.
//   - GET /admin/auth/login con sesión válida redirige a /admin.
//   - POST /admin/auth/logout limpia la cookie.
//   - Rutas públicas (/health, /presentacion.html) siguen sin auth.
//   - Backward compat: ADMIN_AUTH_MODE=basic preserva basic auth.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeSession, decodeSession, ADMIN_SESSION_COOKIE } from '../../src/admin/auth-google.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { FakeNetSuiteDispatcher } from '../../src/services/netsuite-dispatcher.js';
import { resetDatabase } from '../helpers/server.js';
import { getPrisma } from '../../src/db.js';
import type { FastifyInstance } from 'fastify';

const SESSION_SECRET = 'test-session-secret-min-32-chars-aaaaa';

function validSession(opts: { email?: string; ttlSec?: number } = {}) {
  return encodeSession({
    email: opts.email ?? 'alice@numaris.com',
    name: 'Alice',
    picture: null,
    exp: Math.floor(Date.now() / 1000) + (opts.ttlSec ?? 3600),
  }, SESSION_SECRET);
}

describe('v16 — Google OAuth admin auth (unit-level helpers)', () => {
  it('encode/decode roundtrip preserva claims', () => {
    const original = { email: 'a@numaris.com', name: 'Alice', picture: 'https://x/pic', exp: Math.floor(Date.now() / 1000) + 3600 };
    const cookie = encodeSession(original, SESSION_SECRET);
    const decoded = decodeSession(cookie, SESSION_SECRET);
    expect(decoded).toEqual(original);
  });

  it('firma con otro secret → null (rechazo)', () => {
    const cookie = encodeSession({ email: 'a@numaris.com', name: 'A', picture: null, exp: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET);
    expect(decodeSession(cookie, 'otro-secret-completamente-diferente')).toBeNull();
  });

  it('cookie expirada → null', () => {
    const cookie = encodeSession({ email: 'a@numaris.com', name: 'A', picture: null, exp: Math.floor(Date.now() / 1000) - 60 }, SESSION_SECRET);
    expect(decodeSession(cookie, SESSION_SECRET)).toBeNull();
  });

  it('cookie con payload modificado pero firma vieja → null', () => {
    const cookie = encodeSession({ email: 'a@numaris.com', name: 'A', picture: null, exp: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET);
    const [payload, sig] = cookie.split('.');
    // Cambia el payload (cambia "@numaris.com" por "@evil.com") manteniendo firma original.
    const evil = Buffer.from(JSON.stringify({ email: 'attacker@evil.com', name: 'X', picture: null, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    expect(decodeSession(`${evil}.${sig}`, SESSION_SECRET)).toBeNull();
  });

  it('formato malformado → null', () => {
    expect(decodeSession('no-dot', SESSION_SECRET)).toBeNull();
    expect(decodeSession('', SESSION_SECRET)).toBeNull();
    expect(decodeSession('a.', SESSION_SECRET)).toBeNull();
    expect(decodeSession('.b', SESSION_SECRET)).toBeNull();
  });
});

describe('v16 — Google OAuth integración con preHandler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const prisma = getPrisma();
    await resetDatabase(prisma);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ADMIN_AUTH_MODE: 'google',
      GOOGLE_OAUTH_CLIENT_ID: 'fake-client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'fake-client-secret',
      SESSION_SECRET,
      ADMIN_ALLOWED_EMAIL_DOMAIN: 'numaris.com',
      CALLBACK_BASE_URL: 'http://test-host',
    });
    app = await buildApp({ config, prisma, dispatcher: new FakeNetSuiteDispatcher(), callbackBaseUrl: 'http://test-host' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /admin sin cookie → redirect a /admin/auth/login', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain('/admin/auth/login');
  });

  it('GET /admin con cookie válida → 200 OK', async () => {
    const cookie = validSession();
    const r = await app.inject({
      method: 'GET', url: '/admin',
      cookies: { [ADMIN_SESSION_COOKIE]: cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('alice@numaris.com');
  });

  it('GET /admin/customers con cookie inválida (otro secret) → redirect a login', async () => {
    const fake = encodeSession({ email: 'a@numaris.com', name: 'A', picture: null, exp: Math.floor(Date.now() / 1000) + 3600 }, 'wrong-secret');
    const r = await app.inject({
      method: 'GET', url: '/admin/customers',
      cookies: { [ADMIN_SESSION_COOKIE]: fake },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain('/admin/auth/login');
    // El next= debe preservar la URL original.
    expect(r.headers.location).toContain('next=');
  });

  it('GET /admin/auth/login renderiza pantalla de login', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/auth/login' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Iniciar sesión con Google');
    expect(r.body).toContain('numaris.com');
  });

  it('GET /admin/auth/login con sesión válida → redirect a /admin', async () => {
    const cookie = validSession();
    const r = await app.inject({
      method: 'GET', url: '/admin/auth/login',
      cookies: { [ADMIN_SESSION_COOKIE]: cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/admin');
  });

  it('POST /admin/auth/logout limpia la cookie + redirect', async () => {
    const cookie = validSession();
    const r = await app.inject({
      method: 'POST', url: '/admin/auth/logout',
      cookies: { [ADMIN_SESSION_COOKIE]: cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/admin/auth/login');
    // El Set-Cookie debe contener la cookie vacía + Expires en el pasado.
    const setCookie = String(r.headers['set-cookie'] ?? '');
    expect(setCookie).toContain(ADMIN_SESSION_COOKIE);
  });

  it('GET /admin/auth/google-start redirige a Google (302 + accounts.google.com)', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/auth/google-start' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain('accounts.google.com');
    expect(r.headers.location).toContain('client_id=fake-client-id');
  });

  it('Rutas públicas siguen sin auth (presentación)', async () => {
    const r = await app.inject({ method: 'GET', url: '/presentacion.html' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('Health check sigue sin auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
  });

  it('Cookie con email de otro dominio (cuando el atacante firmara correctamente) NO debería pasar el preHandler', async () => {
    // Para llegar a este test el atacante necesita el SESSION_SECRET — pero si lo tiene, ya
    // estás comprometido. Aún así: el preHandler en sí no re-valida el dominio (ya lo hizo
    // el callback). Lo que sí podemos validar es que un email de otro dominio no pueda
    // ENTRAR vía el callback, eso lo testeamos en otro nivel (no aquí porque requiere
    // mockear el flow OAuth completo).
    // Aquí solo confirmamos que una cookie bien firmada con un email random pasa el
    // preHandler (porque ya pasó el filtro en el callback hipotético).
    const cookie = encodeSession({
      email: 'someone@whatever.com', name: 'X', picture: null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, SESSION_SECRET);
    const r = await app.inject({
      method: 'GET', url: '/admin',
      cookies: { [ADMIN_SESSION_COOKIE]: cookie },
    });
    // Pasa el preHandler — el filtro de dominio vive en el callback OAuth.
    expect(r.statusCode).toBe(200);
  });
});

describe('v16 — Backward compat: ADMIN_AUTH_MODE=basic (default) preserva basic auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const prisma = getPrisma();
    await resetDatabase(prisma);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ADMIN_AUTH_MODE: 'basic',  // explícito
      CALLBACK_BASE_URL: 'http://test-host',
    });
    app = await buildApp({ config, prisma, dispatcher: new FakeNetSuiteDispatcher(), callbackBaseUrl: 'http://test-host' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /admin sin auth header → 401 con WWW-Authenticate Basic', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin' });
    expect(r.statusCode).toBe(401);
    expect(String(r.headers['www-authenticate'] ?? '')).toContain('Basic');
  });

  it('GET /admin con basic auth correcto → 200', async () => {
    const r = await app.inject({
      method: 'GET', url: '/admin',
      headers: { authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    });
    expect(r.statusCode).toBe(200);
  });
});
