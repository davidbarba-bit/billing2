// Detalle del plan rediseñado en tabs editoriales. Sustituye el stack de
// 6+ cards apilados por una organización por temas: Resumen / Unidades /
// Add-ons / Precio. Las acciones poco frecuentes (terminar el plan,
// migrar units desde sistema legacy) viven en el tab que les corresponde.

import type { Customer, Service, ServiceAddOn, TaxEntity, Unit } from '@prisma/client';
import { adminContextStorage } from './context.js';
import { DateTime } from 'luxon';
import {
  INPUT_CLASS,
  INPUT_CLASS_MONO,
  badge,
  btn,
  escapeHtml,
  fmtDate,
  fmtDateOnly,
  fmtMoney,
  formField,
  formSection,
  modal,
  modalTrigger,
  pageTitle,
  panel,
  postButton,
  primaryButton,
  secondaryLink,
  statusBadge,
  table,
  tabs,
  techOnly,
} from './views.js';

type ServiceWithRelations = Service & {
  customer: Customer;
  taxEntity: TaxEntity;
  units: Unit[];
  addOns: ServiceAddOn[];
};

export const SERVICE_TABS = ['resumen', 'unidades', 'addons', 'precio'] as const;
export type ServiceTab = (typeof SERVICE_TABS)[number];

export function isServiceTab(value: string | undefined): value is ServiceTab {
  return typeof value === 'string' && (SERVICE_TABS as readonly string[]).includes(value);
}

type EffectivePricing = {
  effectiveMonthly: number;
  effectiveSetup: number;
  pendingActive: boolean;
  pendingFuture: boolean;
};

function computeEffectivePricing(service: ServiceWithRelations): EffectivePricing {
  const now = new Date();
  const pendingActive =
    service.pendingEffectiveFrom !== null
    && service.pendingMonthlyUnitAmountCents !== null
    && service.pendingSetupUnitAmountCents !== null
    && service.pendingEffectiveFrom <= now;
  const pendingFuture =
    service.pendingEffectiveFrom !== null
    && service.pendingMonthlyUnitAmountCents !== null
    && service.pendingSetupUnitAmountCents !== null
    && service.pendingEffectiveFrom > now;
  return {
    effectiveMonthly: pendingActive ? service.pendingMonthlyUnitAmountCents! : service.monthlyUnitAmountCents,
    effectiveSetup: pendingActive ? service.pendingSetupUnitAmountCents! : service.setupUnitAmountCents,
    pendingActive,
    pendingFuture,
  };
}

function pricingModelPill(model: string): string {
  return model === 'one_off'
    ? `<span class="pill pill-info">Prepago</span>`
    : `<span class="pill pill-success">Recurrente</span>`;
}

// --- Header reusable para todos los tabs ---------------------------------

function renderHeader(service: ServiceWithRelations): string {
  const customerLink = `<a class="hover:underline" style="color: var(--accent-deep);" href="/admin/customers/${escapeHtml(service.customer.externalId)}">${escapeHtml(service.customer.name)}</a>`;
  return `<div class="flex items-start justify-between gap-6 mb-2">
    <div>
      <div class="text-[11px] uppercase tracking-[0.14em] mb-2 ink-faint">
        Plan · ${customerLink}
      </div>
      <h1 class="font-display text-[2rem] leading-tight font-medium ink tracking-tight">${escapeHtml(service.name)}</h1>
      <div class="flex items-center gap-2 mt-3">
        ${statusBadge(service.status)}
        ${pricingModelPill(service.pricingModel)}
        ${techOnly(`<code class="font-mono-pro text-xs ink-faint">${escapeHtml(service.code)}</code>`)}
      </div>
    </div>
    <div class="shrink-0">${secondaryLink('/admin/services', '← Planes')}</div>
  </div>`;
}

function renderTabsNav(serviceCode: string, active: ServiceTab, counts: { units: number; addOns: number }): string {
  return tabs({
    baseHref: `/admin/services/${encodeURIComponent(serviceCode)}`,
    active,
    items: [
      { key: 'resumen', label: 'Resumen' },
      { key: 'unidades', label: 'Unidades', count: counts.units },
      { key: 'addons', label: 'Add-ons', count: counts.addOns },
      { key: 'precio', label: 'Precio' },
    ],
  });
}

// --- Tab: Resumen --------------------------------------------------------

function renderResumen(service: ServiceWithRelations, customerTaxEntities: TaxEntity[]): string {
  const pricing = computeEffectivePricing(service);
  const isOneOff = service.pricingModel === 'one_off';

  // 3 cifras grandes: renta mensual, setup, baja (o meses prepagados si prepago).
  const moneyDisplay = (cents: number): string =>
    `<div class="flex items-baseline gap-1.5">
      <span class="font-mono-pro text-[10px] uppercase tracking-wider ink-faint">${escapeHtml(service.currency)}</span>
      <span class="font-mono-pro text-2xl ink num tracking-tight">${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </div>`;

  const headlineMetrics = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-px surface-card mb-8" style="border-radius: 6px; overflow: hidden;">
      <div class="px-6 py-5 surface-card">
        <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">${isOneOff ? 'Renta mensual prepagada' : 'Renta /unidad /periodo'}</div>
        ${moneyDisplay(pricing.effectiveMonthly)}
        ${pricing.pendingFuture ? `<div class="text-[11px] mt-2" style="color: var(--warn);">Cambio programado · ver tab Precio</div>` : ''}
      </div>
      <div class="px-6 py-5 surface-card">
        <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Setup /unidad</div>
        ${moneyDisplay(pricing.effectiveSetup)}
        ${service.setupBillingMode === 'immediate' && pricing.effectiveSetup > 0
          ? `<div class="text-[11px] mt-2" style="color: var(--accent-deep);">Emisión inmediata</div>`
          : pricing.effectiveSetup === 0
            ? `<div class="text-[11px] mt-2 ink-faint">Sin cargo</div>`
            : `<div class="text-[11px] mt-2 ink-faint">Consolidado al cierre</div>`}
      </div>
      <div class="px-6 py-5 surface-card">
        ${isOneOff ? `
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Meses prepagados (default)</div>
          ${service.prepaidMonthsDefault !== null
            ? `<div class="font-mono-pro text-2xl ink num tracking-tight">${service.prepaidMonthsDefault}</div>
               <div class="text-[11px] mt-2 ink-faint">Se puede sobrescribir por unidad</div>`
            : `<div class="font-mono-pro text-2xl" style="color: var(--danger);">—</div>
               <div class="text-[11px] mt-2" style="color: var(--danger);">No configurado · obligatorio por unidad</div>`}
        ` : `
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Baja /unidad</div>
          ${moneyDisplay(service.removalUnitAmountCents)}
          ${service.removalUnitAmountCents === 0
            ? `<div class="text-[11px] mt-2 ink-faint">Sin cargo de desinstalación</div>`
            : service.removalBillingMode === 'immediate'
              ? `<div class="text-[11px] mt-2" style="color: var(--accent-deep);">Emisión inmediata</div>`
              : `<div class="text-[11px] mt-2 ink-faint">Consolidado al cierre</div>`}
        `}
      </div>
    </div>
  `;

  // Panel de configuración — muestra opciones definidas al crear el plan.
  const setupModeLabel = (m: string): string =>
    m === 'immediate' ? 'Inmediato' : 'Al cierre del periodo';
  const removalModeLabel = (m: string): string =>
    m === 'immediate' ? 'Inmediato' : 'Al cierre del periodo';

  const configBlock = (() => {
    const rows = `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
        <div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Modelo de cobro</div>
          <div class="ink">${isOneOff ? 'Prepago' : 'Recurrente'}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Descripción</div>
          <div class="ink">${service.description ? escapeHtml(service.description) : '<span class="ink-faint">— sin descripción</span>'}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Emisión de setup</div>
          <div class="ink">${setupModeLabel(service.setupBillingMode)}</div>
        </div>
        ${!isOneOff ? `<div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Emisión de baja</div>
          <div class="ink">${removalModeLabel(service.removalBillingMode)}</div>
        </div>` : ''}
        ${isOneOff ? `<div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Meses prepagados</div>
          <div class="ink font-mono-pro">${service.prepaidMonthsDefault ?? '<span class="ink-faint">— no configurado</span>'}</div>
        </div>` : ''}
      </div>
    `;
    const editTrigger = service.status !== 'terminated'
      ? `<div class="mt-5 pt-5" style="border-top: 1px solid var(--rule-soft);">${modalTrigger({ modalId: 'modal-config', label: 'Editar configuración' })}</div>`
      : '';
    return rows + editTrigger;
  })();

  const configForm = (() => {
    if (service.status === 'terminated') return '';
    const setupModeOptions = [
      { value: 'next_cycle', label: 'Al cierre del periodo' },
      { value: 'immediate', label: 'Inmediato' },
    ];
    const removalModeOptions = [
      { value: 'next_cycle', label: 'Al cierre del periodo' },
      { value: 'immediate', label: 'Inmediato' },
    ];
    const renderSelect = (name: string, options: Array<{ value: string; label: string }>, selected: string): string => {
      const opts = options.map((o) => {
        const sel = o.value === selected ? 'selected' : '';
        return `<option value="${escapeHtml(o.value)}" ${sel}>${escapeHtml(o.label)}</option>`;
      }).join('');
      return `<select name="${escapeHtml(name)}" class="${INPUT_CLASS}">${opts}</select>`;
    };
    return `
      <form method="post" action="/admin/services/${escapeHtml(service.code)}/config" class="space-y-0">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
          ${formField({
            label: 'Nombre comercial',
            required: true,
            span: 2,
            input: `<input required name="name" value="${escapeHtml(service.name)}" class="${INPUT_CLASS}">`,
          })}
          ${formField({
            label: 'Descripción',
            span: 2,
            hint: 'Texto interno. No se muestra al cliente.',
            input: `<input name="description" value="${escapeHtml(service.description ?? '')}" class="${INPUT_CLASS}">`,
          })}
          ${(!isOneOff && service.setupUnitAmountCents > 0) ? formField({
            label: 'Emisión del setup',
            hint: 'El setup es un cargo único por unidad: consolidado al cierre o factura individual al instalar.',
            input: renderSelect('setup_billing_mode', setupModeOptions, service.setupBillingMode),
          }) : ''}
          ${(!isOneOff && service.removalUnitAmountCents > 0) ? formField({
            label: 'Emisión de la baja',
            hint: 'La baja es un cargo único por unidad: consolidada al cierre o factura individual al dar de baja.',
            input: renderSelect('removal_billing_mode', removalModeOptions, service.removalBillingMode),
          }) : ''}
          ${isOneOff ? formField({
            label: 'Meses prepagados',
            hint: 'Se puede sobrescribir por unidad.',
            input: `<input type="number" name="prepaid_months_default" min="1" value="${service.prepaidMonthsDefault ?? ''}" class="${INPUT_CLASS_MONO} max-w-xs">`,
          }) : ''}
        </div>
        <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
          ${primaryButton('Guardar configuración')}
        </div>
      </form>
    `;
  })();
  const configModal = service.status !== 'terminated'
    ? modal({
        id: 'modal-config',
        title: 'Editar configuración del plan',
        description: 'Nombre, descripción y opciones de emisión. El modelo de cobro (recurrente/prepago) no se puede cambiar después de creado.',
        body: configForm,
      })
    : '';

  // Códigos NetSuite — bloque informativo si todo OK, advertencia si faltan.
  const netsuiteBlock = (() => {
    const missing: string[] = [];
    if (!service.netsuiteMonthlyItemCode) missing.push('mensual');
    if (service.setupUnitAmountCents > 0 && !service.netsuiteSetupItemCode) missing.push('setup');
    if (service.removalUnitAmountCents > 0 && !service.netsuiteRemovalItemCode) missing.push('baja');
    const codesRow = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
        <div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Mensual</div>
          <div class="font-mono-pro ink">${service.netsuiteMonthlyItemCode ?? '<span class="ink-faint">— sin configurar</span>'}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Setup</div>
          <div class="font-mono-pro ink">${service.netsuiteSetupItemCode ?? '<span class="ink-faint">— sin configurar</span>'}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Baja</div>
          <div class="font-mono-pro ink">${service.netsuiteRemovalItemCode ?? '<span class="ink-faint">— sin configurar</span>'}</div>
        </div>
      </div>
    `;
    const banner = missing.length > 0
      ? `<div class="rounded p-4 text-sm mb-4" style="background: var(--warn-soft); color: var(--warn); border: 1px solid var(--warn-soft);">
          <strong>Códigos faltantes:</strong> ${missing.map((m) => `<code class="font-mono-pro">${escapeHtml(m)}</code>`).join(', ')}.
          Las facturas que se emitan con líneas sin código serán rechazadas por NetSuite.
        </div>`
      : `<div class="rounded p-4 text-sm mb-4" style="background: var(--accent-tint); color: var(--accent-deep);">
          Todos los códigos requeridos para este plan están configurados.
        </div>`;
    const editTrigger = `<div class="mt-5 pt-5" style="border-top: 1px solid var(--rule-soft);">${modalTrigger({ modalId: 'modal-netsuite-codes', label: 'Editar códigos' })}</div>`;
    return banner + codesRow + editTrigger;
  })();

  const netsuiteCodesForm = `
    <form method="post" action="/admin/services/${escapeHtml(service.code)}/netsuite-codes" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({
          label: 'Item code mensual',
          input: `<input name="netsuite_monthly_item_code" value="${escapeHtml(service.netsuiteMonthlyItemCode ?? '')}" placeholder="SUB-MONTHLY" class="${INPUT_CLASS_MONO}">`,
          hint: isOneOff ? 'Se usa para las N mensualidades prepagadas.' : 'Se usa cada periodo.',
        })}
        ${formField({
          label: 'Item code setup',
          input: `<input name="netsuite_setup_item_code" value="${escapeHtml(service.netsuiteSetupItemCode ?? '')}" placeholder="SUB-SETUP" class="${INPUT_CLASS_MONO}">`,
          hint: 'Aplica si hay monto de setup mayor a 0.',
        })}
        ${!isOneOff ? formField({
          label: 'Item code baja',
          input: `<input name="netsuite_removal_item_code" value="${escapeHtml(service.netsuiteRemovalItemCode ?? '')}" placeholder="SUB-BAJA" class="${INPUT_CLASS_MONO}">`,
          hint: 'Aplica si hay monto de baja mayor a 0.',
        }) : ''}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton('Guardar códigos')}
      </div>
    </form>
  `;
  const netsuiteCodesModal = modal({
    id: 'modal-netsuite-codes',
    title: 'Editar códigos de producto NetSuite',
    description: 'Estos códigos se envían como item_code en cada línea de factura. NetSuite rechaza líneas sin código válido.',
    body: netsuiteCodesForm,
  });

  // v22: razón social del plan — receptor fiscal de los ciclos de este plan.
  const te = service.taxEntity;
  const teBadges = [
    te.isDefault ? `<span class="pill pill-info">Default del cliente</span>` : '',
    te.active ? '' : `<span class="pill pill-warn">Inactiva</span>`,
  ].filter(Boolean).join(' ');
  const taxEntityBlock = (() => {
    const rows = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4 text-sm">
        <div class="sm:col-span-2">
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Razón social</div>
          <div class="ink">${escapeHtml(te.legalName)} ${teBadges}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">RFC</div>
          <div class="ink font-mono-pro">${te.taxIdentificationNumber ? escapeHtml(te.taxIdentificationNumber) : '<span class="ink-faint">— sin RFC</span>'}</div>
        </div>
      </div>
    `;
    const editTrigger = service.status !== 'terminated' && customerTaxEntities.length > 1
      ? `<div class="mt-5 pt-5" style="border-top: 1px solid var(--rule-soft);">${modalTrigger({ modalId: 'modal-tax-entity', label: 'Cambiar razón social' })}</div>`
      : (service.status !== 'terminated'
        ? `<div class="mt-4 text-xs ink-faint">El cliente solo tiene una razón social. Crea otra en <a class="hover:underline" style="color: var(--accent-deep);" href="/admin/customers/${escapeHtml(service.customer.externalId)}?tab=datos">Datos fiscales</a> para poder cambiarla.</div>`
        : '');
    return rows + editTrigger;
  })();

  const taxEntityModal = service.status !== 'terminated' && customerTaxEntities.length > 1
    ? modal({
        id: 'modal-tax-entity',
        title: 'Cambiar razón social del plan',
        description: 'Aplica a los próximos ciclos. Las facturas ya emitidas conservan su razón social.',
        body: `
          <form method="post" action="/admin/services/${escapeHtml(service.code)}/tax-entity" class="space-y-0">
            <div class="mb-6">
              ${formField({
                label: 'Razón social',
                input: `<select name="tax_entity_id" class="${INPUT_CLASS}">${customerTaxEntities.map((opt) => {
                  const sel = opt.id === service.taxEntityId ? 'selected' : '';
                  const label = (opt.isDefault ? `${opt.legalName} (default)` : opt.legalName)
                    + (opt.taxIdentificationNumber ? ` — ${opt.taxIdentificationNumber}` : '')
                    + (opt.active ? '' : ' [inactiva]');
                  return `<option value="${escapeHtml(opt.id)}" ${sel}>${escapeHtml(label)}</option>`;
                }).join('')}</select>`,
              })}
            </div>
            <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
              ${primaryButton('Guardar razón social')}
            </div>
          </form>
        `,
      })
    : '';

  // Acciones del plan — terminate + link a invoices del cliente.
  const terminateForm = service.status !== 'terminated'
    ? postButton(`/admin/services/${service.code}/terminate`, 'Terminar plan', 'danger', `¿Terminar ${service.code}? Las unidades activas quedarán dadas de baja a la fecha actual.`)
    : '<span class="text-sm ink-faint">Plan terminado el ' + fmtDateOnly(service.terminatedAt) + '</span>';
  const invoicesLink = `<a class="text-sm hover:underline" style="color: var(--accent-deep);" href="/admin/customers/${escapeHtml(service.customer.externalId)}?tab=facturas">Ver facturas del cliente →</a>`;

  return headlineMetrics
    + panel({
      title: 'Configuración del plan',
      description: 'Opciones definidas al crear el plan.',
      body: configBlock,
    })
    + panel({
      title: 'Razón social',
      description: 'Entidad fiscal a la que se factura este plan.',
      body: taxEntityBlock,
    })
    + panel({
      title: 'NetSuite · códigos de producto',
      description: 'Mapeo de líneas de factura al catálogo de NetSuite.',
      body: netsuiteBlock,
    })
    + panel({
      title: 'Acciones',
      body: `<div class="flex items-center gap-4">${terminateForm}<span>${invoicesLink}</span></div>`,
    })
    + configModal
    + taxEntityModal
    + netsuiteCodesModal;
}

// --- Tab: Unidades -------------------------------------------------------

function renderUnidades(service: ServiceWithRelations): string {
  const isOneOff = service.pricingModel === 'one_off';

  const unitsTable = service.units.length === 0
    ? `<div class="text-sm ink-faint italic py-6 text-center">Sin unidades. Crea la primera con el formulario de migración o vía la API de eventos.</div>`
    : table({
        rows: service.units,
        empty: 'Sin unidades',
        columns: [
          { label: 'Identificador', render: (u) => `<code class="font-mono-pro text-xs">${escapeHtml(u.externalId)}</code>${u.label ? `<div class="text-xs ink-faint mt-0.5">${escapeHtml(u.label)}</div>` : ''}` },
          { label: 'Status', render: (u) => statusBadge(u.activeTo === null ? 'active' : 'terminated') },
          { label: 'Activa desde', render: (u) => fmtDateOnly(u.activeFrom) },
          { label: 'Facturación', render: (u) => u.billingStartsAt
            ? `<span style="color: var(--warn);" title="override de fecha de facturación (migración)">${escapeHtml(fmtDateOnly(u.billingStartsAt))}</span>`
            : '<span class="ink-faint">desde activa</span>' },
          { label: 'Activa hasta', render: (u) => fmtDateOnly(u.activeTo) },
          ...(isOneOff
            ? [
                { label: 'Meses prepagados', render: (u: Unit) => u.prepaidMonths !== null
                  ? `<span class="font-mono-pro">${u.prepaidMonths}m</span>`
                  : (service.prepaidMonthsDefault !== null
                    ? `<span class="font-mono-pro ink-faint">${service.prepaidMonthsDefault}m <span class="text-[10px]">default</span></span>`
                    : '<span style="color: var(--danger);">obligatorio</span>') },
                { label: 'Prepago', render: (u: Unit) => u.oneoffBilledAt
                  ? `<span class="pill pill-success">facturado</span>`
                  : `<span class="pill pill-warn">pendiente</span>` },
              ]
            : [
                { label: 'Setup', render: (u: Unit) =>
                  service.setupUnitAmountCents === 0
                    ? '<span class="ink-faint text-xs">n/a</span>'
                    : (u.setupBilledAt ? `<span class="pill pill-success">facturado</span>` : `<span class="pill pill-warn">pendiente</span>`)
                },
                { label: 'Baja', render: (u: Unit) =>
                  service.removalUnitAmountCents === 0
                    ? '<span class="ink-faint text-xs">n/a</span>'
                    : (u.activeTo === null
                      ? '<span class="ink-faint text-xs">activa</span>'
                      : (u.removalBilledAt ? `<span class="pill pill-success">facturada</span>` : `<span class="pill pill-warn">pendiente</span>`))
                },
              ]),
          { label: '', render: (u: Unit) => `<a class="text-xs hover:underline" style="color: var(--accent-deep);" href="/admin/units/${u.id}/edit">editar</a>` },
        ],
      });

  const migrateForm = service.status === 'terminated' ? '' : renderMigrateUnitForm(service);
  const migrateModal = migrateForm
    ? modal({
        id: 'modal-new-unit',
        title: 'Agregar unidad',
        description: 'Crea una unidad con fechas explícitas de activación y facturación. El identificador externo lo proporciona el sistema externo (GPS, video, etc.).',
        body: migrateForm,
      })
    : '';

  const addButton = service.status !== 'terminated'
    ? modalTrigger({ modalId: 'modal-new-unit', label: '+ Agregar unidad' })
    : '';

  return panel({
    title: `Unidades · ${service.units.length}`,
    description: 'Cada unidad representa un dispositivo o un servicio individual asociado a este plan.',
    actions: addButton,
    body: unitsTable,
  }) + migrateModal;
}

function renderMigrateUnitForm(service: ServiceWithRelations): string {
  const isOneOff = service.pricingModel === 'one_off';
  return `
    <form method="post" action="/admin/services/${escapeHtml(service.code)}/units" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({
          label: 'Identificador externo',
          required: true,
          input: `<input required name="external_id" placeholder="gps-001" class="${INPUT_CLASS_MONO}">`,
          hint: 'ID estable proporcionado por el sistema externo.',
        })}
        ${formField({
          label: 'Etiqueta',
          input: `<input name="label" placeholder="Camión 001" class="${INPUT_CLASS}">`,
          hint: 'Texto humano descriptivo (opcional).',
        })}
        ${formField({
          label: 'Activa desde',
          required: true,
          input: `<input required type="datetime-local" name="active_from" class="${INPUT_CLASS}">`,
          hint: 'Verdad operativa — cuándo empezó a reportar.',
        })}
        ${formField({
          label: 'Empieza a facturarse',
          input: `<input type="datetime-local" name="billing_starts_at" class="${INPUT_CLASS}">`,
          hint: 'Override opcional. Si lo dejas vacío se factura desde activa.',
        })}
        ${isOneOff ? formField({
          label: `Meses prepagados (default del plan: ${service.prepaidMonthsDefault ?? '—'})`,
          span: 2,
          input: `<input type="number" name="prepaid_months" min="1" class="${INPUT_CLASS_MONO}" style="max-width: 12rem;">`,
        }) : ''}
      </div>
      <div class="rounded p-4 text-sm mb-6" style="background: var(--warn-soft); border: 1px solid var(--warn-soft);">
        <div class="text-[10px] uppercase tracking-wider font-medium mb-2" style="color: var(--warn);">Cobros ya pagados afuera</div>
        ${isOneOff ? `
          <label class="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" name="one_off_already_billed" value="1" class="mt-0.5">
            <span class="text-sm ink-soft">El paquete prepago ya se facturó en el sistema legacy (setup + N mensualidades). La unidad no se cobrará al primer evento ni al cierre.</span>
          </label>
        ` : `
          <label class="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" name="setup_already_billed" value="1" class="mt-0.5">
            <span class="text-sm ink-soft">El setup ya se facturó en el sistema legacy. La unidad sigue facturando renta normal pero no incluirá el renglón de setup.</span>
          </label>
        `}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton('Crear unidad')}
      </div>
    </form>
  `;
}

// --- Tab: Add-ons --------------------------------------------------------

function renderAddons(service: ServiceWithRelations): string {
  const addonsTable = service.addOns.length === 0
    ? `<div class="text-sm ink-faint italic py-6 text-center">Sin add-ons. Los add-ons per-unit se cobran sobre cada unidad activa del plan.</div>`
    : table({
        rows: service.addOns,
        empty: 'Sin add-ons',
        columns: [
          { label: 'Código', render: (a) => `<code class="font-mono-pro text-xs">${escapeHtml(a.code)}</code>` },
          { label: 'Nombre', render: (a) => escapeHtml(a.name) },
          { label: 'Monto /unidad', render: (a) => `<span class="font-mono-pro">${fmtMoney(a.amountCents, service.currency)}</span> <span class="ink-faint text-xs">/mes</span>` },
          { label: 'Status', render: (a) => statusBadge(a.activeTo === null ? 'active' : 'terminated') },
          { label: 'Vigente desde', render: (a) => fmtDateOnly(a.activeFrom) },
          { label: 'Vigente hasta', render: (a) => fmtDateOnly(a.activeTo) },
          { label: '', render: (a) => a.activeTo === null
            ? postButton(`/admin/service-add-ons/${a.id}/terminate`, 'Terminar', 'danger', `¿Terminar add-on ${a.code}?`)
            : '<span class="ink-faint text-xs">terminado</span>' },
        ],
      });

  const addonForm = `
    <form method="post" action="/admin/services/${escapeHtml(service.code)}/add-ons" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({
          label: 'Nombre',
          required: true,
          span: 2,
          hint: 'El código se genera automáticamente.',
          input: `<input required name="name" placeholder="Historial 6 → 12 meses" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Monto por unidad',
          required: true,
          hint: `Se cobra mensualmente sobre cada unidad activa. En ${escapeHtml(service.currency)}.`,
          input: `<div class="relative">
            <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[11px] font-mono-pro uppercase tracking-wider ink-faint">${escapeHtml(service.currency)}</span>
            <input required type="number" step="0.01" min="0" name="amount" placeholder="0.00" class="${INPUT_CLASS_MONO} pl-14 text-right">
          </div>`,
        })}
        ${formField({
          label: 'Item code NetSuite',
          input: `<input name="netsuite_item_code" placeholder="ADDON-PERUNIT" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Descripción',
          span: 2,
          input: `<input name="description" class="${INPUT_CLASS}">`,
        })}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton('Crear add-on')}
      </div>
    </form>
  `;

  const addonModal = service.status !== 'terminated'
    ? modal({
        id: 'modal-new-addon',
        title: 'Nuevo add-on per-unit',
        description: 'Cargo adicional mensual que se cobra sobre cada unidad activa del plan.',
        body: addonForm,
      })
    : '';

  const addButton = service.status !== 'terminated'
    ? modalTrigger({ modalId: 'modal-new-addon', label: '+ Agregar add-on' })
    : '';

  return panel({
    title: `Add-ons per-unit · ${service.addOns.length}`,
    description: 'Cargos adicionales que se cobran sobre cada unidad activa del plan. Si necesitas un cargo flat independiente, agrégalo a nivel del cliente.',
    actions: addButton,
    body: addonsTable,
  }) + addonModal;
}

// --- Tab: Precio ---------------------------------------------------------

function renderPrecio(service: ServiceWithRelations): string {
  const pricing = computeEffectivePricing(service);

  if (service.status === 'terminated') {
    return panel({
      title: 'Precio',
      body: `<div class="text-sm ink-faint italic">Plan terminado — los precios no se pueden modificar.</div>`,
    });
  }

  // Snapshot del precio vigente.
  const currentBlock = `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
      <div>
        <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Renta mensual /unidad (vigente)</div>
        <div class="font-mono-pro text-2xl ink num">${(pricing.effectiveMonthly / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="text-[10px] uppercase ink-faint">${escapeHtml(service.currency)}</span></div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Setup /unidad (vigente)</div>
        <div class="font-mono-pro text-2xl ink num">${(pricing.effectiveSetup / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="text-[10px] uppercase ink-faint">${escapeHtml(service.currency)}</span></div>
      </div>
    </div>
  `;

  // Cambio pendiente (si existe).
  const pendingBlock = pricing.pendingFuture ? `
    <div class="rounded p-4 mb-6" style="background: var(--warn-soft); border: 1px solid var(--warn-soft);">
      <div class="text-[10px] uppercase tracking-[0.14em] font-medium mb-3" style="color: var(--warn);">Cambio programado</div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <div>
          <div class="text-xs ink-faint">Mensual</div>
          <div class="font-mono-pro ink mt-1">${fmtMoney(service.pendingMonthlyUnitAmountCents!, service.currency)}</div>
        </div>
        <div>
          <div class="text-xs ink-faint">Setup</div>
          <div class="font-mono-pro ink mt-1">${fmtMoney(service.pendingSetupUnitAmountCents!, service.currency)}</div>
        </div>
        <div>
          <div class="text-xs ink-faint">Entra en vigor</div>
          <div class="ink mt-1">${fmtDateOnly(service.pendingEffectiveFrom!)}</div>
        </div>
      </div>
      <div class="mt-4">
        ${postButton(`/admin/services/${service.code}/pending-price/cancel`, 'Cancelar cambio programado', 'danger', '¿Cancelar el cambio de precio programado?')}
      </div>
    </div>
  ` : '<div class="text-sm ink-faint mb-6">No hay cambio de precio programado.</div>';

  // Form para programar nuevo cambio.
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const yyyy = tomorrow.getUTCFullYear();
  const mm = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getUTCDate()).padStart(2, '0');
  const defaultEffective = `${yyyy}-${mm}-${dd}T00:00`;
  const tz = adminContextStorage.getStore()?.displayTz ?? 'UTC';

  const scheduleForm = `
    <form method="post" action="/admin/services/${escapeHtml(service.code)}/price" class="space-y-5">
      <p class="text-sm ink-soft">El nuevo precio aplicará a las unidades de este plan cuyo periodo de facturación empiece en o después de la fecha indicada. Las unidades que ya están en un ciclo mantienen el precio vigente hasta el siguiente cierre.</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
        ${formField({
          label: 'Nuevo monto mensual /unidad (cents)',
          required: true,
          input: `<input required type="number" name="monthly_unit_amount_cents" min="0" value="${pricing.effectiveMonthly}" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Nuevo setup /unidad (cents)',
          required: true,
          input: `<input required type="number" name="setup_unit_amount_cents" min="0" value="${pricing.effectiveSetup}" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Vigente a partir de',
          required: true,
          span: 2,
          hint: `Se interpreta en tu zona <code class="font-mono-pro">${escapeHtml(tz)}</code> (la de Ajustes).`,
          input: `<input required type="datetime-local" name="effective_from" value="${defaultEffective}" class="${INPUT_CLASS}">`,
        })}
      </div>
      ${primaryButton(pricing.pendingFuture ? 'Sobrescribir cambio programado' : 'Programar cambio')}
    </form>
  `;

  return panel({
    title: 'Precio vigente',
    body: currentBlock + pendingBlock,
  }) + panel({
    title: pricing.pendingFuture ? 'Sobrescribir cambio programado' : 'Programar cambio de precio',
    body: scheduleForm,
    toned: true,
  });
}

// --- Entry point ---------------------------------------------------------

export function renderServiceDetail(args: {
  service: ServiceWithRelations;
  tab: ServiceTab;
  customerTaxEntities: TaxEntity[];
}): string {
  const counts = { units: args.service.units.length, addOns: args.service.addOns.length };
  const tabContent = (() => {
    switch (args.tab) {
      case 'resumen': return renderResumen(args.service, args.customerTaxEntities);
      case 'unidades': return renderUnidades(args.service);
      case 'addons': return renderAddons(args.service);
      case 'precio': return renderPrecio(args.service);
    }
  })();
  return renderHeader(args.service)
    + renderTabsNav(args.service.code, args.tab, counts)
    + tabContent;
}
