// Form rediseñado de "Nuevo plan" (alias service en el modelo). Usa los
// helpers de v21 (panel, formSection, formField, moneyInput) para una
// presentación coherente: secciones claras, hints en lenguaje de negocio
// (sin referencias a v17/v18 ni a "ping"), montos en pesos en lugar de
// centavos. La currency se hereda del cliente automáticamente.

import type { Customer } from '@prisma/client';
import {
  INPUT_CLASS,
  INPUT_CLASS_MONO,
  escapeHtml,
  formField,
  formSection,
  pageTitle,
  panel,
  primaryButton,
  secondaryLink,
} from './views.js';

type CustomerLite = Pick<Customer, 'externalId' | 'name' | 'currency'>;

export function renderServiceNewForm(args: {
  customers: CustomerLite[];
  selectedCustomerExternalId?: string;
  form?: Record<string, string | undefined>;
}): string {
  const { customers, form = {} } = args;

  // Determinar el cliente "activo" en el form (preselected por query param,
  // por valor del form en re-render, o el primero).
  const selectedExt = form.customer_external_id
    ?? args.selectedCustomerExternalId
    ?? customers[0]?.externalId
    ?? '';
  const selected = customers.find((c) => c.externalId === selectedExt) ?? customers[0];
  const currency = selected?.currency ?? 'MXN';

  const v = (k: string): string => escapeHtml(form[k] ?? '');
  const isSelected = (k: string, candidate: string): boolean =>
    (form[k] ?? '') === candidate;

  // Selector de cliente — agrupa nombre y external_id para escaneo rápido.
  const customerOptions = customers.map((c) => {
    const sel = c.externalId === selectedExt ? 'selected' : '';
    return `<option value="${escapeHtml(c.externalId)}" data-currency="${escapeHtml(c.currency)}" ${sel}>${escapeHtml(c.name)} — ${escapeHtml(c.externalId)}</option>`;
  }).join('');

  // Modelo de cobro como radio cards editoriales — la decisión cambia
  // qué campos aplican (setup/baja vs prepaid_months), conviene visualizarlo.
  // El estado activo se maneja con CSS :has() para que el cambio sea
  // instantáneo sin JS frágil.
  const pricingModelField = (() => {
    const current = form.pricing_model ?? 'recurring';
    const card = (value: 'recurring' | 'one_off', title: string, description: string): string => {
      return `<label class="pricing-card relative cursor-pointer p-5 transition-all" style="border-style: solid; border-width: 1px; border-radius: 4px;">
        <input type="radio" name="pricing_model" value="${value}" ${current === value ? 'checked' : ''} class="sr-only">
        <div class="flex items-start gap-3">
          <span class="pricing-card-dot inline-flex w-4 h-4 rounded-full items-center justify-center">
            <span class="pricing-card-dot-inner w-1.5 h-1.5 rounded-full"></span>
          </span>
          <div class="flex-1">
            <div class="pricing-card-title font-display text-[15px] font-medium leading-tight">${escapeHtml(title)}</div>
            <div class="text-[13px] ink-soft mt-1.5 leading-relaxed">${escapeHtml(description)}</div>
          </div>
        </div>
      </label>`;
    };
    return `<style>
      .pricing-card { background: #FFFFFF; border-color: var(--rule); }
      .pricing-card-dot { border: 1.5px solid var(--rule); }
      .pricing-card-dot-inner { background: transparent; }
      .pricing-card:has(input[type="radio"]:checked) { background: var(--accent-soft); border-color: var(--accent); }
      .pricing-card:has(input[type="radio"]:checked) .pricing-card-dot { border-color: var(--accent); }
      .pricing-card:has(input[type="radio"]:checked) .pricing-card-dot-inner { background: var(--accent); }
      .pricing-card:has(input[type="radio"]:checked) .pricing-card-title { color: var(--accent); }
      .pricing-card:hover:not(:has(input[type="radio"]:checked)) { border-color: var(--ink-faint); }
      /* Mostrar el campo "Meses prepagados" solo cuando Prepago está seleccionado */
      .prepago-only { display: none; }
      form:has(input[name="pricing_model"][value="one_off"]:checked) .prepago-only { display: block; }
    </style>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${card('recurring', 'Recurrente', 'Renta mensual por unidad activa. Opcionalmente setup al instalar y baja al desinstalar.')}
      ${card('one_off', 'Prepago', 'Setup opcional + N mensualidades pagadas por adelantado al recibir el primer evento.')}
    </div>`;
  })();

  // Sección "Identificación" — cliente, código, nombre, descripción.
  const identificationSection = formSection({
    title: 'Identificación',
    description: 'Datos básicos del plan. El código es inmutable; el resto se puede editar después.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
        ${formField({
          label: 'Cliente',
          required: true,
          span: 2,
          hint: `La moneda del plan (<code class="font-mono">${escapeHtml(currency)}</code>) se hereda del cliente.`,
          input: `<select required name="customer_external_id" id="customer-select" class="${INPUT_CLASS}">${customerOptions}</select>`,
        })}
        ${formField({
          label: 'Código',
          required: true,
          hint: 'Identificador único del plan dentro de la organización. Inmutable.',
          input: `<input required name="code" value="${v('code')}" placeholder="combustible-foo" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Nombre comercial',
          required: true,
          hint: 'Aparece en facturas y reportes.',
          input: `<input required name="name" value="${v('name')}" placeholder="Combustible · sensor de tanque" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Descripción',
          span: 2,
          hint: 'Texto interno. No se muestra al cliente.',
          input: `<input name="description" value="${v('description')}" class="${INPUT_CLASS}">`,
        })}
      </div>
    `,
  });

  // Sección "Modelo de cobro" — radio cards que disparan el resto del form.
  const pricingSection = formSection({
    title: 'Modelo de cobro',
    description: 'Define cómo se factura el plan a lo largo del tiempo. El resto del formulario cambia según la elección.',
    body: pricingModelField,
  });

  // Sección "Cargos" — montos en pesos (no centavos). Una nota recuerda que
  // los impuestos los calcula NetSuite, no el motor.
  const chargesSection = formSection({
    title: 'Cargos',
    description: 'Montos por unidad. NetSuite agrega los impuestos al emitir el CFDI — aquí solo el neto.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-5">
        ${formField({
          label: 'Renta mensual por unidad',
          required: true,
          hint: 'En servicios recurrentes se cobra cada periodo. En prepago se multiplica por los meses prepagados.',
          input: moneyInputInline({ name: 'monthly_unit_amount', currency, value: form.monthly_unit_amount, required: true, placeholder: '0.00' }),
        })}
        ${formField({
          label: 'Setup por unidad',
          hint: 'Cargo único cuando entra la unidad. Dejar en 0 si el plan no cobra instalación.',
          input: moneyInputInline({ name: 'setup_unit_amount', currency, value: form.setup_unit_amount ?? '0' }),
        })}
        ${formField({
          label: 'Baja por unidad',
          hint: 'Cargo único cuando la unidad termina. Solo aplica a recurrentes — en prepago ya se cobró todo por adelantado.',
          input: moneyInputInline({ name: 'removal_unit_amount', currency, value: form.removal_unit_amount ?? '0' }),
        })}
      </div>
      <div class="prepago-only mt-5">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-5">
          ${formField({
            label: 'Meses prepagados',
            required: true,
            hint: 'Cuántos meses paga el cliente por adelantado al instalar cada unidad. Se puede sobrescribir por unidad.',
            input: `<input type="number" name="prepaid_months_default" min="1" value="${v('prepaid_months_default')}" placeholder="48" class="${INPUT_CLASS_MONO} max-w-xs">`,
          })}
        </div>
      </div>
    `,
  });

  const setupModeOptions = [
    { value: 'next_cycle', label: 'Al cierre del periodo (consolidado con la renta)' },
    { value: 'immediate', label: 'Inmediato (factura individual al instalar la unidad)' },
  ];
  const removalModeOptions = [
    { value: 'next_cycle', label: 'Al cierre del periodo (consolidado con la renta del periodo de la baja)' },
    { value: 'immediate', label: 'Inmediato (factura individual al dar de baja)' },
  ];
  const emissionSection = formSection({
    title: 'Emisión de cargos no recurrentes',
    description: 'Cuándo emitir factura para setup y baja.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
        ${formField({
          label: 'Cuándo emitir el setup',
          hint: 'Solo aplica si el monto de setup es mayor a 0.',
          input: renderSelect('setup_billing_mode', setupModeOptions, form.setup_billing_mode ?? 'next_cycle'),
        })}
        ${formField({
          label: 'Cuándo emitir la baja',
          hint: 'Solo aplica a planes recurrentes con monto de baja mayor a 0.',
          input: renderSelect('removal_billing_mode', removalModeOptions, form.removal_billing_mode ?? 'next_cycle'),
        })}
      </div>
    `,
  });

  // Sección "Integración con NetSuite" — los 3 item codes mapeados a líneas
  // de factura. Se puede dejar vacío en demos / staging, pero NetSuite
  // rechazará las invoices en producción.
  const netsuiteSection = formSection({
    title: 'Integración con NetSuite',
    description: 'Códigos del catálogo de NetSuite a los que se mapean las líneas de la factura. Si quedan vacíos, NetSuite rechazará el dispatch.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-5">
        ${formField({
          label: 'Item code · mensual',
          hint: 'Recurrente: cada periodo. Prepago: las N mensualidades pagadas por adelantado.',
          input: `<input name="netsuite_monthly_item_code" value="${v('netsuite_monthly_item_code')}" placeholder="SUB-MONTHLY" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Item code · setup',
          hint: 'Cargo único por unidad al instalar.',
          input: `<input name="netsuite_setup_item_code" value="${v('netsuite_setup_item_code')}" placeholder="SUB-SETUP" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Item code · baja',
          hint: 'Cargo único por unidad al desinstalar.',
          input: `<input name="netsuite_removal_item_code" value="${v('netsuite_removal_item_code')}" placeholder="SUB-BAJA" class="${INPUT_CLASS_MONO}">`,
        })}
      </div>
    `,
  });

  const actions = `
    <div class="flex items-center gap-3 pt-6 mt-2 border-t border-slate-200">
      ${primaryButton('Crear plan')}
      ${secondaryLink('/admin/services', 'Cancelar')}
      <span class="ml-auto text-xs text-slate-500">El ciclo de facturación lo define el cliente, no el plan.</span>
    </div>
  `;

  const form_ = `
    <form method="post" action="/admin/services" class="space-y-0">
      ${identificationSection}
      ${pricingSection}
      ${chargesSection}
      ${emissionSection}
      ${netsuiteSection}
      ${actions}
    </form>
  `;

  return pageTitle({
    eyebrow: 'Catálogo de planes',
    title: 'Nuevo plan',
    description: 'Un plan agrupa el cómo se cobra un servicio: precio por unidad, setup, baja y los códigos de NetSuite. Las unidades concretas se asignan después.',
    actions: secondaryLink('/admin/services', '← Planes'),
  }) + panel({ body: form_ });
}

// --- helpers internos ----------------------------------------------------

function moneyInputInline(opts: {
  name: string;
  currency: string;
  value?: string;
  required?: boolean;
  placeholder?: string;
}): string {
  const required = opts.required ? 'required' : '';
  const placeholder = opts.placeholder ?? '0.00';
  return `<div class="relative">
    <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[11px] font-mono-pro uppercase tracking-wider ink-faint">${escapeHtml(opts.currency)}</span>
    <input ${required} type="number" step="0.01" min="0" name="${escapeHtml(opts.name)}" value="${escapeHtml(opts.value ?? '')}" placeholder="${escapeHtml(placeholder)}" class="${INPUT_CLASS_MONO} pl-14 text-right">
  </div>`;
}

function renderSelect(
  name: string,
  options: Array<{ value: string; label: string }>,
  selected: string,
): string {
  const opts = options.map((o) => {
    const sel = o.value === selected ? 'selected' : '';
    return `<option value="${escapeHtml(o.value)}" ${sel}>${escapeHtml(o.label)}</option>`;
  }).join('');
  return `<select name="${escapeHtml(name)}" class="${INPUT_CLASS}">${opts}</select>`;
}
