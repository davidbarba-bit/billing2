// Unit tests para el traductor payload canónico → factura estándar NetSuite.
// Es lógica pura (sin BD), así que corre en el suite unit.

import { describe, expect, it } from 'vitest';
import { buildStandardInvoice } from '../../src/services/netsuite-dispatcher.js';

const baseCanonical = () => ({
  external_id: 'inv-abc',
  minilago_invoice_id: 'inv-abc',
  issued_at: '2026-06-12T18:30:00.000Z',
  currency: 'MXN',
  customer: {
    external_id: 'transportes-marva',
    netsuite_internal_id: '4321',
    netsuite_entity_handle: '4321',
  },
  billing_period: { from: '2026-06-01T06:00:00.000Z', to: '2026-07-01T05:59:59.000Z' },
  lines: [
    {
      fee_id: 'fee-1', kind: 'monthly', description: 'Renta mensual',
      units: '3.0000', unit_amount_cents: 45000, amount_cents: 135000,
      netsuite_item_code: 'NS-COMB-MONTHLY',
    },
  ],
});

describe('buildStandardInvoice', () => {
  it('mapea entity por internal id (handle) y líneas por external id de ítem', () => {
    const rec = buildStandardInvoice(baseCanonical(), {}) as Record<string, any>;
    expect(rec.externalId).toBe('inv-abc');
    expect(rec.entity).toEqual({ id: '4321' });
    expect(rec.tranDate).toBe('2026-06-12');
    // itemRefMode default = external → eid:<code>
    expect(rec.item.items[0].item).toEqual({ id: 'eid:NS-COMB-MONTHLY' });
    expect(rec.item.items[0].quantity).toBe(3);
    expect(rec.item.items[0].rate).toBe(450);
    expect(rec.item.items[0].amount).toBe(1350);
  });

  it('sin currencyRef cae a refName ISO; con mapa usa internal id', () => {
    const noMap = buildStandardInvoice(baseCanonical(), {}) as Record<string, any>;
    expect(noMap.currency).toEqual({ refName: 'MXN' });
    const mapped = buildStandardInvoice(baseCanonical(), { currencyRef: { MXN: '1' } }) as Record<string, any>;
    expect(mapped.currency).toEqual({ id: '1' });
  });

  it('incluye subsidiaria solo si está configurada', () => {
    expect((buildStandardInvoice(baseCanonical(), {}) as Record<string, any>).subsidiary).toBeUndefined();
    const withSub = buildStandardInvoice(baseCanonical(), { subsidiaryId: '2' }) as Record<string, any>;
    expect(withSub.subsidiary).toEqual({ id: '2' });
  });

  it('entityRefMode=external referencia al cliente por eid del external_id', () => {
    const rec = buildStandardInvoice(baseCanonical(), { entityRefMode: 'external' }) as Record<string, any>;
    expect(rec.entity).toEqual({ id: 'eid:transportes-marva' });
  });

  it('itemRefMode=internal usa el código como internal id directo', () => {
    const rec = buildStandardInvoice(baseCanonical(), { itemRefMode: 'internal' }) as Record<string, any>;
    expect(rec.item.items[0].item).toEqual({ id: 'NS-COMB-MONTHLY' });
  });

  it('falla claro si una línea no tiene código de ítem', () => {
    const bad = baseCanonical();
    bad.lines = [{ ...bad.lines[0]!, netsuite_item_code: null as unknown as string }];
    expect(() => buildStandardInvoice(bad, {})).toThrow(/missing_item_code/);
  });

  it('falla claro si no hay líneas', () => {
    const empty = { ...baseCanonical(), lines: [] };
    expect(() => buildStandardInvoice(empty, {})).toThrow(/no_invoice_lines/);
  });

  it('cae a eid del external_id cuando no hay internal id ni handle', () => {
    const c = baseCanonical();
    c.customer.netsuite_internal_id = null as unknown as string;
    c.customer.netsuite_entity_handle = undefined as unknown as string;
    const rec = buildStandardInvoice(c, {}) as Record<string, any>;
    expect(rec.entity).toEqual({ id: 'eid:transportes-marva' });
  });
});
