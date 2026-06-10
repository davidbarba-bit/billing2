// v22 — el external_id del customer debe ser un slug ASCII (sin espacios
// ni acentos). El usuario suele confundir este campo con el nombre comercial
// y mete cosas como "Translopez Pérez SAPI de CV" — lo que rompe los URLs
// del admin (encoding inválido). La validación detecta el error en la POST.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v22 — customer.external_id slug ASCII', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function create(externalId: string) {
    return h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: externalId, name: externalId } },
    });
  }

  it.each([
    'transportes-marva',
    'cust_001',
    'TM.123',
    'a',
    'ABC-xyz_42.test',
  ])('acepta slug válido: %s', async (id) => {
    const r = await create(id);
    expect(r.statusCode).toBe(200);
  });

  it.each([
    'Translopez Pérez SAPI de CV',  // espacios + acento
    'con espacios',
    'café',
    'Empresa, SA',
    'a/b',
    'with#hash',
    '',                              // vacío
  ])('rechaza id inválido: %s', async (id) => {
    const r = await create(id);
    expect(r.statusCode).toBe(422);
    if (id !== '') expect(r.body).toContain('must_be_ascii_slug');
  });
});
