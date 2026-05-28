// Billing engine — v4.
//
// Cambios clave vs v3:
//   1. `billingPeriodFor` ahora calcula periodos de N meses (1/3/6/12) anclados
//      al día N del mes (1..28). El primer periodo de un customer puede ser un
//      "stub" parcial entre subscription_at y el primer anchor alineado.
//   2. Services con pricing_model='one_off':
//      - No tienen monthly recurrente ni setup.
//      - Cobran 1 vez per_unit cuando aparece la unit (kind='one_off').
//      - Si customer.nonrecurring_trigger='immediate' → 1 invoice individual
//        emitida al instante del POST /events (no participan en la cycle invoice).
//      - Si customer.nonrecurring_trigger='next_cycle' → la unit espera hasta
//        el cierre del ciclo y sale en la cycle invoice del customer.
//      - En ambos casos: la unit se marca `oneoff_billed_at` y no vuelve a
//        aparecer en facturas futuras.

import type {
  Customer,
  CustomerAddOn,
  Prisma,
  PrismaClient,
  Service,
  ServiceAddOn,
  Unit,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { applyFraction, bankersRound, fraction4 } from './rounding.js';
import { isoUtc } from './tz.js';

export type FeeKind = 'monthly' | 'setup' | 'removal' | 'service_addon' | 'customer_addon' | 'one_off';

export type BilledUnitDetail = {
  external_id: string;
  label: string | null;
  active_from: string;
  active_to: string | null;
  billed_fraction: string;
  amount_cents: number;
};

export type ComputedFee = {
  kind: FeeKind;
  serviceId?: string;
  serviceAddOnId?: string;
  customerAddOnId?: string;
  description: string;
  units: string;
  unitAmountCents: number;
  preciseUnitAmount: string;
  amountCents: number;
  // v9: código NetSuite resuelto desde la entidad fuente al momento de
  // construir la fee. null si no estaba configurado.
  netsuiteItemCode: string | null;
  billedUnitsDetail: BilledUnitDetail[];
  unitIds: string[];
};

export type ComputedInvoice = {
  fees: ComputedFee[];
  feesAmountCents: number;
  unitsAnnex: Array<{
    external_id: string;
    label: string | null;
    fees: Array<{ kind: FeeKind; amount_cents: number }>;
  }>;
};

export type ServiceForBilling = Service & {
  units: Unit[];
  addOns: ServiceAddOn[];
};

// v7: resuelve el precio efectivo del Service para un instante dado. Si el
// service tiene un cambio de precio programado y el instante alcanza o pasa
// `pendingEffectiveFrom`, devuelve los valores `pending*`. Si no, los actuales.
// `at` es el inicio del periodo facturado (cycle) o `now` para cargos one-off
// inmediatos.
export function effectivePriceFor(
  service: Pick<Service,
    | 'monthlyUnitAmountCents'
    | 'setupUnitAmountCents'
    | 'pendingMonthlyUnitAmountCents'
    | 'pendingSetupUnitAmountCents'
    | 'pendingEffectiveFrom'
  >,
  at: Date,
): { monthlyUnitAmountCents: number; setupUnitAmountCents: number } {
  if (
    service.pendingEffectiveFrom !== null
    && service.pendingMonthlyUnitAmountCents !== null
    && service.pendingSetupUnitAmountCents !== null
    && at >= service.pendingEffectiveFrom
  ) {
    return {
      monthlyUnitAmountCents: service.pendingMonthlyUnitAmountCents,
      setupUnitAmountCents: service.pendingSetupUnitAmountCents,
    };
  }
  return {
    monthlyUnitAmountCents: service.monthlyUnitAmountCents,
    setupUnitAmountCents: service.setupUnitAmountCents,
  };
}

function withEffectivePrice<S extends Service>(service: S, at: Date): S {
  const eff = effectivePriceFor(service, at);
  if (
    eff.monthlyUnitAmountCents === service.monthlyUnitAmountCents
    && eff.setupUnitAmountCents === service.setupUnitAmountCents
  ) {
    return service;
  }
  return {
    ...service,
    monthlyUnitAmountCents: eff.monthlyUnitAmountCents,
    setupUnitAmountCents: eff.setupUnitAmountCents,
  };
}

export type ComputeOptions = {
  customer: Customer;
  services: ServiceForBilling[];
  customerAddOns: CustomerAddOn[];
  periodStart: Date;
  periodEnd: Date;
  daysInPeriod: number;
  // v8: tz del customer (o de la organización si el customer no la setea).
  // Necesaria para definir "mes calendario" correctamente para la proración.
  tz: string;
};

// ---------------------------------------------------------------------------
// Cycle invoice (POST /api/v1/invoices con customer_external_id).
// Agrega fees de TODOS los services del customer:
//   - recurring → monthly + setup + service_addon (prorrateados)
//   - one_off + next_cycle → one_off fees pendientes (marca billed)
//   - one_off + immediate → no participa (se factura per-ping aparte)
// + customer_addons flat (prorrateados) + tax stack.
// ---------------------------------------------------------------------------
export function computeCustomerInvoice(opts: ComputeOptions): ComputedInvoice {
  const { customer, services, customerAddOns, periodStart, periodEnd, tz } = opts;
  const fees: ComputedFee[] = [];

  for (const rawService of services) {
    if (rawService.status !== 'active') continue;
    // v7: resuelve el precio efectivo en función del inicio del periodo. Si
    // el customer está mid-cycle cuando se programa el cambio, su periodo
    // actual mantiene el precio viejo; el próximo ciclo (start >= effective_from)
    // ya usa el nuevo.
    const service = withEffectivePrice(rawService, periodStart);

    if (service.pricingModel === 'recurring') {
      const monthlyFee = buildMonthlyFee(service, service.units, periodStart, periodEnd, tz);
      if (monthlyFee) fees.push(monthlyFee);
      const setupFee = buildSetupFee(service, service.units, periodStart, periodEnd);
      if (setupFee) fees.push(setupFee);
      const removalFee = buildRemovalFee(service, service.units, periodEnd);
      if (removalFee) fees.push(removalFee);
      for (const addOn of service.addOns) {
        if (addOn.activeFrom > periodEnd) continue;
        if (addOn.activeTo !== null && addOn.activeTo <= periodStart) continue;
        const addOnFrom = addOn.activeFrom < periodStart ? periodStart : addOn.activeFrom;
        const addOnTo = addOn.activeTo === null
          ? periodEnd
          : (addOn.activeTo > periodEnd ? periodEnd : addOn.activeTo);
        const fee = buildServiceAddOnFee(service, addOn, addOnFrom, addOnTo, tz, periodStart, periodEnd);
        if (fee) fees.push(fee);
      }
    } else if (service.pricingModel === 'one_off') {
      // Solo si el customer acumula one-offs hasta el cierre. El modo
      // "immediate" emite invoice individual desde el handler de /events
      // (ver `computeOneOffPingInvoice`), no aquí.
      if (customer.nonrecurringTrigger !== 'next_cycle') continue;
      // v8: el "trigger del periodo" usa billingStartsAt si está seteado.
      const pending = service.units
        .filter((u) => {
          if (u.oneoffBilledAt !== null) return false;
          const billStart = unitBillingStart(u);
          return billStart <= periodEnd && billStart >= periodStart;
        })
        .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
      for (const unit of pending) {
        const unitFees = buildOneOffFeesForUnit(service, unit);
        fees.push(...unitFees);
      }
    }
  }

  for (const addOn of customerAddOns) {
    if (addOn.activeFrom > periodEnd) continue;
    if (addOn.activeTo !== null && addOn.activeTo <= periodStart) continue;
    const from = addOn.activeFrom < periodStart ? periodStart : addOn.activeFrom;
    const to = addOn.activeTo === null
      ? periodEnd
      : (addOn.activeTo > periodEnd ? periodEnd : addOn.activeTo);
    const fee = buildCustomerAddOnFee(addOn, from, to, tz);
    if (fee) fees.push(fee);
  }

  return finalize(fees);
}

// ---------------------------------------------------------------------------
// Factura individual por un único ping (modo immediate).
// Genera setup (si aplica) + mensualidades prepagadas para UNA unit.
// ---------------------------------------------------------------------------
// v18: setup inmediato — invoice independiente con UNA fee kind='setup' para
// UNA unit. Se invoca al crear la unit (POST /api/v1/units) si el service
// tiene setupBillingMode='immediate'. La fee respeta effectivePriceFor.
export function computeSetupImmediateInvoice(opts: {
  service: Service;
  unit: Unit;
  now?: Date;
}): ComputedInvoice {
  const { service: rawService, unit } = opts;
  if (rawService.pricingModel !== 'recurring') {
    throw new Error('computeSetupImmediateInvoice requires pricing_model=recurring');
  }
  const at = opts.now ?? new Date();
  const service = withEffectivePrice(rawService, at);
  if (service.setupUnitAmountCents <= 0) {
    throw new Error('setup_unit_amount_cents must be > 0 for setup_immediate');
  }
  const fee: ComputedFee = {
    kind: 'setup',
    serviceId: service.id,
    description: `${service.name} — setup × 1`,
    units: '1.0000',
    unitAmountCents: service.setupUnitAmountCents,
    preciseUnitAmount: (service.setupUnitAmountCents / 100).toFixed(2),
    amountCents: service.setupUnitAmountCents,
    netsuiteItemCode: service.netsuiteSetupItemCode ?? null,
    billedUnitsDetail: [{
      external_id: unit.externalId, label: unit.label,
      active_from: isoUtc(unit.activeFrom), active_to: null,
      billed_fraction: '1.0000', amount_cents: service.setupUnitAmountCents,
    }],
    unitIds: [unit.id],
  };
  return finalize([fee]);
}

// v18: baja inmediata — invoice independiente con UNA fee kind='removal' para
// UNA unit. Se invoca al setear active_to en la unit (PATCH /api/v1/units/:id)
// si el service tiene removalBillingMode='immediate'.
export function computeRemovalImmediateInvoice(opts: {
  service: Service;
  unit: Unit;
  now?: Date;
}): ComputedInvoice {
  const { service: rawService, unit } = opts;
  if (rawService.pricingModel !== 'recurring') {
    throw new Error('computeRemovalImmediateInvoice requires pricing_model=recurring');
  }
  if (service_removalAmount(rawService) <= 0) {
    throw new Error('removal_unit_amount_cents must be > 0 for removal_immediate');
  }
  const fee: ComputedFee = {
    kind: 'removal',
    serviceId: rawService.id,
    description: `${rawService.name} — baja × 1`,
    units: '1.0000',
    unitAmountCents: rawService.removalUnitAmountCents,
    preciseUnitAmount: (rawService.removalUnitAmountCents / 100).toFixed(2),
    amountCents: rawService.removalUnitAmountCents,
    netsuiteItemCode: rawService.netsuiteRemovalItemCode ?? null,
    billedUnitsDetail: [{
      external_id: unit.externalId, label: unit.label,
      active_from: isoUtc(unit.activeFrom), active_to: unit.activeTo ? isoUtc(unit.activeTo) : null,
      billed_fraction: '1.0000', amount_cents: rawService.removalUnitAmountCents,
    }],
    unitIds: [unit.id],
  };
  return finalize([fee]);
}

function service_removalAmount(s: Service): number {
  return s.removalUnitAmountCents;
}

export function computeOneOffPingInvoice(opts: {
  service: Service;
  unit: Unit;
  now?: Date;
}): ComputedInvoice {
  const { service: rawService, unit } = opts;
  if (rawService.pricingModel !== 'one_off') throw new Error('computeOneOffPingInvoice requires pricing_model=one_off');
  // v7: pings inmediatos toman el precio vigente AL MOMENTO del ping (no
  // existe "siguiente ciclo" para nonrecurring_trigger=immediate; el ping
  // genera la invoice al instante). Si el admin programó un cambio con
  // effective_from futuro, este ping aún usa el precio viejo. Si effective_from
  // ya pasó, usa el nuevo.
  const at = opts.now ?? new Date();
  const service = withEffectivePrice(rawService, at);
  if (service.monthlyUnitAmountCents <= 0) throw new Error('one_off service has zero monthlyUnitAmountCents');
  return finalize(buildOneOffFeesForUnit(service, unit));
}

// ---------------------------------------------------------------------------
// Builder one-off por unit. Genera 1-2 fees:
//   - kind='setup' (units=1, amount=setup_unit_amount_cents) si setup > 0
//   - kind='one_off' (units=N meses, amount=N × monthly_unit_amount_cents)
// donde N = unit.prepaidMonths ?? service.prepaidMonthsDefault.
// Lanza error si N no está definido o es <= 0.
// ---------------------------------------------------------------------------
function buildOneOffFeesForUnit(service: Service, unit: Unit): ComputedFee[] {
  const months = unit.prepaidMonths ?? service.prepaidMonthsDefault ?? null;
  if (months === null || months <= 0) {
    throw new Error(
      `unit ${unit.externalId}: prepaid_months no especificado (ni en la unit ni en el service "${service.code}")`,
    );
  }

  const unitLabel = unit.label ?? unit.externalId;
  const fees: ComputedFee[] = [];

  // Renglón de SETUP (si el service tiene setup > 0).
  if (service.setupUnitAmountCents > 0) {
    fees.push({
      kind: 'setup',
      serviceId: service.id,
      description: `Setup ${service.name} — ${unitLabel}`,
      units: '1.0000',
      unitAmountCents: service.setupUnitAmountCents,
      preciseUnitAmount: (service.setupUnitAmountCents / 100).toFixed(2),
      amountCents: service.setupUnitAmountCents,
      netsuiteItemCode: service.netsuiteSetupItemCode ?? null,
      billedUnitsDetail: [{
        external_id: unit.externalId,
        label: unit.label,
        active_from: isoUtc(unit.activeFrom),
        active_to: null,
        billed_fraction: '1.0000',
        amount_cents: service.setupUnitAmountCents,
      }],
      unitIds: [unit.id],
    });
  }

  // Renglón de MENSUALIDADES PREPAGADAS (N meses × monthly_amount).
  const monthlyTotal = months * service.monthlyUnitAmountCents;
  fees.push({
    kind: 'one_off',
    serviceId: service.id,
    description: `Mensualidad ${service.name} — ${unitLabel}`,
    units: `${months}.0000`,
    unitAmountCents: service.monthlyUnitAmountCents,
    preciseUnitAmount: (service.monthlyUnitAmountCents / 100).toFixed(2),
    amountCents: monthlyTotal,
    // v10: la mensualidad prepagada mapea al MISMO item de NetSuite que la
    // mensualidad recurrente (es la misma "renta mensual" conceptual, solo
    // cobrada por anticipado).
    netsuiteItemCode: service.netsuiteMonthlyItemCode ?? null,
    billedUnitsDetail: [{
      external_id: unit.externalId,
      label: unit.label,
      active_from: isoUtc(unit.activeFrom),
      active_to: null,
      billed_fraction: `${months}.0000`,
      amount_cents: monthlyTotal,
    }],
    unitIds: [unit.id],
  });

  return fees;
}

// ---------------------------------------------------------------------------
// Finalize: arma units_annex. mini-Lago NO calcula impuestos — NetSuite los
// agrega cuando emite el CFDI según la configuración fiscal del cliente.
// ---------------------------------------------------------------------------
function finalize(fees: ComputedFee[]): ComputedInvoice {
  const feesAmountCents = fees.reduce((acc, f) => acc + f.amountCents, 0);

  const annexMap = new Map<string, { external_id: string; label: string | null; fees: Array<{ kind: FeeKind; amount_cents: number }> }>();
  for (const fee of fees) {
    for (const d of fee.billedUnitsDetail) {
      let entry = annexMap.get(d.external_id);
      if (!entry) { entry = { external_id: d.external_id, label: d.label, fees: [] }; annexMap.set(d.external_id, entry); }
      if (!entry.label && d.label) entry.label = d.label;
      entry.fees.push({ kind: fee.kind, amount_cents: d.amount_cents });
    }
  }
  const unitsAnnex = Array.from(annexMap.values()).sort((a, b) => (a.external_id < b.external_id ? -1 : 1));

  return { fees, feesAmountCents, unitsAnnex };
}

// ---------------------------------------------------------------------------
// Helpers de prorrateo.
// ---------------------------------------------------------------------------

function daysInInterval(from: Date, to: Date, tz = 'UTC'): number {
  const fromDt = DateTime.fromJSDate(from, { zone: 'utc' }).setZone(tz).startOf('day');
  const toDt = DateTime.fromJSDate(to, { zone: 'utc' }).setZone(tz).plus({ seconds: 1 }).startOf('day');
  return Math.max(0, Math.round(toDt.diff(fromDt, 'days').days));
}

// v8: prorrateo basado en MES CALENDARIO en la tz del customer.
//
// `monthly_unit_amount_cents` representa la renta de UN MES CALENDARIO
// COMPLETO (28/29/30/31 días según el mes). Cuando la unit está activa
// durante una porción de uno o más meses, el factor es la suma de
//   Σ días_activos_en_mes_X / días_del_mes_X
//
// Ejemplos (tz=America/Mexico_City):
//   - Unit activa todo mayo 2026 (31 días): 31/31 = 1.0
//   - Stub mid-mes: unit activa 15-may → 1-jun (17 días): 17/31 = 0.5484
//   - Cycle 3M (1-jun → 1-sep), unit activa todo: 30/30 + 31/31 + 31/31 = 3.0
//   - Unit activa 15-jun → 15-ago: 16/30 + 31/31 + 15/31 = 2.0172
//
// Esto reemplaza la semántica vieja `días_activos / días_del_periodo` que
// trataba al stub como periodo "completo" y cobraba renta entera por menos
// de un mes. También deja que ciclos multi-mes facturen N × renta_mensual
// en lugar de 1 × renta_mensual para todo el ciclo.
export function calendarMonthFraction(from: Date, to: Date, tz: string): number {
  let acc = 0;
  let cursor = DateTime.fromJSDate(from, { zone: 'utc' }).setZone(tz);
  // `to` es inclusivo (típicamente …T23:59:59Z); +1s lo lleva al siguiente
  // segundo para que startOf('day') quede on-or-after el día siguiente.
  const end = DateTime.fromJSDate(to, { zone: 'utc' }).setZone(tz).plus({ seconds: 1 });
  if (end <= cursor) return 0;
  let guard = 0;
  while (cursor < end) {
    if (++guard > 60) break; // hard cap por si algo se rompiera (60 meses de cycle máx).
    const monthStart = cursor.startOf('month');
    const monthEnd = monthStart.plus({ months: 1 });
    const chunkEnd = end < monthEnd ? end : monthEnd;
    const chunkFromDay = cursor.startOf('day');
    const chunkToDay = chunkEnd.startOf('day');
    const chunkDays = Math.max(0, Math.round(chunkToDay.diff(chunkFromDay, 'days').days));
    const daysInMonth = Math.round(monthEnd.diff(monthStart, 'days').days); // 28/29/30/31
    if (daysInMonth > 0) acc += chunkDays / daysInMonth;
    cursor = monthEnd;
  }
  return acc;
}

type UnitEntry = { unit: Unit; activeFrom: Date; activeTo: Date | null; fraction: string };

// v8: para todos los cálculos de billing usamos `billingStartsAt ?? activeFrom`.
// `activeFrom` queda como "cuándo empezó a reportar la unit" (verdad operativa),
// `billingStartsAt` permite anclar la facturación a una fecha distinta (p.ej.
// migrar mid-mes pero cobrar el mes completo, o saltarse el mes facturado por
// la plataforma anterior).
export function unitBillingStart(unit: Pick<Unit, 'activeFrom' | 'billingStartsAt'>): Date {
  return unit.billingStartsAt ?? unit.activeFrom;
}

function buildUnitEntries(
  units: Unit[],
  periodStart: Date,
  periodEnd: Date,
  tz: string,
  clampFrom: Date = periodStart,
  clampTo: Date = periodEnd,
): UnitEntry[] {
  const entries: UnitEntry[] = [];
  for (const unit of units) {
    const billStart = unitBillingStart(unit);
    if (unit.activeTo !== null && unit.activeTo <= periodStart) continue;
    if (billStart > periodEnd) continue;
    const effFrom = new Date(Math.max(billStart.getTime(), clampFrom.getTime()));
    const effTo = unit.activeTo === null
      ? clampTo
      : new Date(Math.min(unit.activeTo.getTime(), clampTo.getTime()));
    if (effTo <= effFrom) continue;
    const fraction = calendarMonthFraction(effFrom, effTo, tz);
    if (fraction <= 0) continue;
    entries.push({ unit, activeFrom: effFrom, activeTo: unit.activeTo === null ? null : effTo, fraction: fraction4(fraction) });
  }
  entries.sort((a, b) => (a.unit.externalId < b.unit.externalId ? -1 : 1));
  return entries;
}

function distribute(entries: UnitEntry[], unitAmountCents: number): { amountCents: number; distributed: number[] } {
  const totalFraction = entries.reduce((acc, e) => acc + Number(e.fraction), 0);
  const amountCents = bankersRound(totalFraction * unitAmountCents);
  const nominal = entries.map((e) => applyFraction(e.fraction, unitAmountCents));
  const subtotal = nominal.reduce((a, b) => a + b, 0);
  const residual = amountCents - subtotal;
  let bestIdx = 0;
  let bestFraction = -1;
  for (let i = 0; i < entries.length; i++) {
    const v = Number(entries[i]!.fraction);
    if (v > bestFraction) { bestFraction = v; bestIdx = i; }
  }
  const distributed = [...nominal];
  if (residual !== 0 && distributed.length > 0) distributed[bestIdx] = distributed[bestIdx]! + residual;
  return { amountCents, distributed };
}

function buildMonthlyFee(service: Service, units: Unit[], periodStart: Date, periodEnd: Date, tz: string): ComputedFee | null {
  if (service.monthlyUnitAmountCents <= 0) return null;
  const entries = buildUnitEntries(units, periodStart, periodEnd, tz);
  if (entries.length === 0) return null;
  const { amountCents, distributed } = distribute(entries, service.monthlyUnitAmountCents);
  const totalFractionStr = fraction4(entries.reduce((acc, e) => acc + Number(e.fraction), 0));
  const detail: BilledUnitDetail[] = entries.map((e, i) => ({
    external_id: e.unit.externalId, label: e.unit.label,
    active_from: isoUtc(e.activeFrom), active_to: e.activeTo ? isoUtc(e.activeTo) : null,
    billed_fraction: e.fraction, amount_cents: distributed[i]!,
  }));
  return {
    kind: 'monthly', serviceId: service.id,
    description: `${service.name} — ${entries.length} unidad${entries.length === 1 ? '' : 'es'} (factor ${totalFractionStr} meses-unidad)`,
    units: totalFractionStr, unitAmountCents: service.monthlyUnitAmountCents,
    preciseUnitAmount: (service.monthlyUnitAmountCents / 100).toFixed(2),
    amountCents,
    netsuiteItemCode: service.netsuiteMonthlyItemCode ?? null,
    billedUnitsDetail: detail, unitIds: entries.map((e) => e.unit.id),
  };
}

function buildSetupFee(service: Service, units: Unit[], periodStart: Date, periodEnd: Date): ComputedFee | null {
  if (service.setupUnitAmountCents <= 0) return null;
  // v8: el gate del setup también se mueve con billing_starts_at — si la
  // facturación de la unit empieza después del periodEnd, el setup tampoco
  // se cobra todavía.
  const setupCandidates = units
    .filter((u) => u.setupBilledAt === null && unitBillingStart(u) <= periodEnd && (u.activeTo === null || u.activeTo >= periodStart))
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
  if (setupCandidates.length === 0) return null;
  const detail: BilledUnitDetail[] = setupCandidates.map((u) => ({
    external_id: u.externalId, label: u.label,
    active_from: isoUtc(u.activeFrom), active_to: null,
    billed_fraction: '1.0000', amount_cents: service.setupUnitAmountCents,
  }));
  const amountCents = service.setupUnitAmountCents * setupCandidates.length;
  return {
    kind: 'setup', serviceId: service.id,
    description: `${service.name} — setup × ${setupCandidates.length}`,
    units: `${setupCandidates.length}.0000`, unitAmountCents: service.setupUnitAmountCents,
    preciseUnitAmount: (service.setupUnitAmountCents / 100).toFixed(2),
    amountCents,
    netsuiteItemCode: service.netsuiteSetupItemCode ?? null,
    billedUnitsDetail: detail, unitIds: setupCandidates.map((u) => u.id),
  };
}

// v17: cargo de baja (desinstalación). Espejo del setup: se cobra una sola vez
// por unit, en el primer cycle invoice posterior a que la unit termine
// (activeTo != null). Si removalUnitAmountCents=0 → no genera fee. Si la baja
// fue por migración de plan, el endpoint correspondiente ya seteó
// removalBilledAt en la unit vieja, así que naturalmente la salta.
function buildRemovalFee(service: Service, units: Unit[], periodEnd: Date): ComputedFee | null {
  if (service.removalUnitAmountCents <= 0) return null;
  const candidates = units
    .filter((u) => u.activeTo !== null && u.activeTo <= periodEnd && u.removalBilledAt === null)
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
  if (candidates.length === 0) return null;
  const detail: BilledUnitDetail[] = candidates.map((u) => ({
    external_id: u.externalId, label: u.label,
    active_from: isoUtc(u.activeFrom), active_to: u.activeTo ? isoUtc(u.activeTo) : null,
    billed_fraction: '1.0000', amount_cents: service.removalUnitAmountCents,
  }));
  const amountCents = service.removalUnitAmountCents * candidates.length;
  return {
    kind: 'removal', serviceId: service.id,
    description: `${service.name} — baja × ${candidates.length}`,
    units: `${candidates.length}.0000`, unitAmountCents: service.removalUnitAmountCents,
    preciseUnitAmount: (service.removalUnitAmountCents / 100).toFixed(2),
    amountCents,
    netsuiteItemCode: service.netsuiteRemovalItemCode ?? null,
    billedUnitsDetail: detail, unitIds: candidates.map((u) => u.id),
  };
}

// One-off agrupado: 1 fee por service con TODAS las units one-off pendientes
// que se activaron dentro del periodo. Modo next_cycle.
function buildServiceAddOnFee(
  service: ServiceForBilling, addOn: ServiceAddOn, addOnFrom: Date, addOnTo: Date,
  tz: string, periodStart: Date, periodEnd: Date,
): ComputedFee | null {
  if (addOn.amountCents <= 0) return null;
  const entries = buildUnitEntries(service.units, periodStart, periodEnd, tz, addOnFrom, addOnTo);
  if (entries.length === 0) return null;
  const { amountCents, distributed } = distribute(entries, addOn.amountCents);
  const totalFractionStr = fraction4(entries.reduce((acc, e) => acc + Number(e.fraction), 0));
  const detail: BilledUnitDetail[] = entries.map((e, i) => ({
    external_id: e.unit.externalId, label: e.unit.label,
    active_from: isoUtc(e.activeFrom), active_to: e.activeTo ? isoUtc(e.activeTo) : null,
    billed_fraction: e.fraction, amount_cents: distributed[i]!,
  }));
  return {
    kind: 'service_addon', serviceId: service.id, serviceAddOnId: addOn.id,
    description: `${addOn.name} (${service.name}) — ${entries.length} unidad${entries.length === 1 ? '' : 'es'}, factor ${totalFractionStr}`,
    units: totalFractionStr, unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents,
    netsuiteItemCode: addOn.netsuiteItemCode ?? null,
    billedUnitsDetail: detail, unitIds: entries.map((e) => e.unit.id),
  };
}

function buildCustomerAddOnFee(addOn: CustomerAddOn, from: Date, to: Date, tz: string): ComputedFee | null {
  if (addOn.amountCents <= 0) return null;
  const fraction = calendarMonthFraction(from, to, tz);
  if (fraction <= 0) return null;
  const fractionStr = fraction4(fraction);
  const amountCents = bankersRound(fraction * addOn.amountCents);
  return {
    kind: 'customer_addon', customerAddOnId: addOn.id,
    description: `${addOn.name} (flat · factor ${fractionStr} meses)`,
    units: fractionStr, unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents,
    netsuiteItemCode: addOn.netsuiteItemCode ?? null,
    billedUnitsDetail: [{
      external_id: `customer-addon:${addOn.code}`, label: addOn.name,
      active_from: isoUtc(from), active_to: isoUtc(to),
      billed_fraction: fractionStr, amount_cents: amountCents,
    }],
    unitIds: [],
  };
}

// ---------------------------------------------------------------------------
// Period helper v4: intervalos N meses anclados a día N del mes.
//
// Si `reference` cae antes del primer anchor alineado, el periodo es un stub
// desde subscription_at hasta el primer anchor (los días parciales del primer
// mes se prorratean dentro de ese stub más corto).
// ---------------------------------------------------------------------------
export function billingPeriodFor(
  customer: Customer,
  tz: string,
  reference: Date = new Date(),
): { start: Date; end: Date; daysInPeriod: number } {
  const anchor = Math.min(28, Math.max(1, customer.billingAnchorDay));
  const months = customer.billingPeriodMonths;
  const subDt = DateTime.fromJSDate(customer.subscriptionAt, { zone: 'utc' }).setZone(tz).startOf('day');
  const refDt = DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz).startOf('day');

  // v15: si el customer tiene billing_anchor_month set y el periodo es
  // multi-mes, alineamos los ciclos a ese mes calendario (independiente
  // del mes en que cae subscription_at). Si NULL o monthly, comportamiento
  // legacy: anclamos al mes de subscription_at avanzando 1 mes si el día
  // de anchor ya pasó.
  let firstAnchor: DateTime;
  if (customer.billingAnchorMonth != null && months > 1) {
    // Candidate: anchor_month/anchor_day en el año de subscription_at.
    // Avanzamos por `months` (no 1) hasta caer on-or-after subscription_at,
    // así los cycles quedan alineados al mes ancla independientemente de
    // dónde caiga subscription_at.
    const anchorMonth = Math.min(12, Math.max(1, customer.billingAnchorMonth));
    firstAnchor = subDt.set({ month: anchorMonth, day: anchor });
    while (firstAnchor < subDt) firstAnchor = firstAnchor.plus({ months });
  } else {
    // Legacy: primer anchor alineado on-or-after subscription_at en el mismo
    // mes (o el siguiente si el día ya pasó). Para monthly, avanza 1 mes;
    // para multi-mes sin anchor_month, equivale a anclar al mes de
    // subscription_at.
    firstAnchor = subDt.set({ day: anchor });
    if (firstAnchor < subDt) firstAnchor = firstAnchor.plus({ months: 1 });
  }

  if (refDt < firstAnchor) {
    // Stub: [subscription_at, primer anchor).
    const start = subDt;
    const end = firstAnchor.minus({ seconds: 1 });
    return {
      start: start.toUTC().toJSDate(),
      end: end.toUTC().toJSDate(),
      daysInPeriod: Math.max(1, Math.round(firstAnchor.diff(start, 'days').days)),
    };
  }

  // Periodo alineado regular que contiene `reference`.
  const monthsSinceAnchor = Math.floor(refDt.diff(firstAnchor, 'months').months);
  const periodIndex = Math.floor(monthsSinceAnchor / months);
  const start = firstAnchor.plus({ months: periodIndex * months });
  const end = start.plus({ months }).minus({ seconds: 1 });
  return {
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
    daysInPeriod: Math.max(1, Math.round(start.plus({ months }).diff(start, 'days').days)),
  };
}

export async function markSetupsBilled(
  prisma: PrismaClient,
  unitIds: string[],
  billedAt: Date = new Date(),
): Promise<void> {
  if (unitIds.length === 0) return;
  await prisma.unit.updateMany({
    where: { id: { in: unitIds }, setupBilledAt: null },
    data: { setupBilledAt: billedAt },
  });
}

export async function markOneOffBilled(
  prisma: PrismaClient,
  unitIds: string[],
  billedAt: Date = new Date(),
): Promise<void> {
  if (unitIds.length === 0) return;
  await prisma.unit.updateMany({
    where: { id: { in: unitIds }, oneoffBilledAt: null },
    data: { oneoffBilledAt: billedAt },
  });
}

export async function markRemovalsBilled(
  prisma: PrismaClient,
  unitIds: string[],
  billedAt: Date = new Date(),
): Promise<void> {
  if (unitIds.length === 0) return;
  await prisma.unit.updateMany({
    where: { id: { in: unitIds }, removalBilledAt: null },
    data: { removalBilledAt: billedAt },
  });
}

// Helper para persistir las fees de un ComputedInvoice. Usado por el handler
// principal y por el handler de pings inmediatos.
export async function persistComputedInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  computed: ComputedInvoice,
): Promise<void> {
  for (let i = 0; i < computed.fees.length; i++) {
    const fee = computed.fees[i]!;
    await tx.fee.create({
      data: {
        invoiceId,
        serviceId: fee.serviceId ?? null,
        serviceAddOnId: fee.serviceAddOnId ?? null,
        customerAddOnId: fee.customerAddOnId ?? null,
        kind: fee.kind,
        description: fee.description,
        units: fee.units,
        unitAmountCents: fee.unitAmountCents,
        preciseUnitAmount: fee.preciseUnitAmount,
        amountCents: fee.amountCents,
        netsuiteItemCode: fee.netsuiteItemCode,
        billedUnitsDetail: fee.billedUnitsDetail as object,
        position: i,
      },
    });
  }
}
