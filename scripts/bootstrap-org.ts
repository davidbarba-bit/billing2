// Bootstrap o rotación de una organización con API key segura.
//
// Uso:
//   npx tsx scripts/bootstrap-org.ts --slug NUM-PROD --name "Numaris (prod)" \
//     --timezone America/Mexico_City [--callback-secret <secret>] [--rotate-key]
//
// Comportamiento:
//   - Si la organización con --slug no existe: la crea con una apiKey nueva
//     generada (32 bytes random, base64url). Si pasas --callback-secret,
//     se setea ese; si no, se autogenera otro de 32 bytes.
//   - Si ya existe:
//       · Sin --rotate-key: NO toca la key y solo actualiza name/timezone si
//         fueron pasados como flags. Imprime la key sigue siendo la actual
//         (no se muestra; tendrías que consultarla en la BD).
//       · Con --rotate-key: genera una key nueva y la setea. La vieja queda
//         invalidada — cualquier cliente que la use recibirá 401.
//
// Imprime la apiKey UNA VEZ por stdout. Copiala a un gestor de secretos
// (1Password / Bitwarden / Railway env vars) y bórrala de la terminal.
// Si la pierdes, vuelve a correr el script con --rotate-key.
//
// IMPORTANTE: este script NO valida que estés conectado a la BD correcta.
// Asegúrate de que DATABASE_URL apunta al ambiente que quieres tocar.

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';

function genApiKey(): string {
  // 32 bytes = 256 bits de entropía; base64url para que sea seguro en URLs y
  // en variables de entorno (sin /, +, =).
  return randomBytes(32).toString('base64url');
}

function genCallbackSecret(): string {
  return randomBytes(32).toString('base64url');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      timezone: { type: 'string' },
      'callback-secret': { type: 'string' },
      'rotate-key': { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (!values.slug) {
    console.error('error: --slug es requerido (ej. NUM-PROD, NUM-STAGING)');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.organization.findUnique({ where: { slug: values.slug } });

    if (!existing) {
      // Crear nueva.
      const apiKey = genApiKey();
      const callbackSecret = values['callback-secret'] ?? genCallbackSecret();
      const created = await prisma.organization.create({
        data: {
          slug: values.slug,
          name: values.name ?? values.slug,
          timezone: values.timezone ?? 'America/Mexico_City',
          apiKey,
          netsuiteCallbackSecret: callbackSecret,
        },
      });
      console.log('');
      console.log('Organización CREADA:');
      console.log(`  id:                       ${created.id}`);
      console.log(`  slug:                     ${created.slug}`);
      console.log(`  name:                     ${created.name}`);
      console.log(`  timezone:                 ${created.timezone}`);
      console.log('');
      console.log('Secretos (cópialos a tu gestor de secretos AHORA — no se muestran de nuevo):');
      console.log(`  API_KEY:                  ${apiKey}`);
      console.log(`  NETSUITE_CALLBACK_SECRET: ${callbackSecret}`);
      console.log('');
      return;
    }

    // Ya existe.
    const updates: Record<string, string> = {};
    if (values.name && values.name !== existing.name) updates.name = values.name;
    if (values.timezone && values.timezone !== existing.timezone) updates.timezone = values.timezone;
    if (values['callback-secret']) updates.netsuiteCallbackSecret = values['callback-secret'];

    if (values['rotate-key']) {
      const newKey = genApiKey();
      updates.apiKey = newKey;
      await prisma.organization.update({ where: { id: existing.id }, data: updates });
      console.log('');
      console.log(`Organización ACTUALIZADA + API KEY ROTADA: ${existing.slug}`);
      console.log('La key vieja queda invalidada.');
      console.log('');
      console.log('Nueva key (cópiala AHORA — no se muestra de nuevo):');
      console.log(`  API_KEY:                  ${newKey}`);
      if (updates.netsuiteCallbackSecret) {
        console.log(`  NETSUITE_CALLBACK_SECRET: ${updates.netsuiteCallbackSecret}`);
      }
      console.log('');
      return;
    }

    if (Object.keys(updates).length === 0) {
      console.log(`Organización "${existing.slug}" ya existe. Sin cambios (no se pasó --rotate-key ni campos para actualizar).`);
      return;
    }

    await prisma.organization.update({ where: { id: existing.id }, data: updates });
    console.log(`Organización "${existing.slug}" actualizada. La API key NO fue rotada (pasa --rotate-key si quieres).`);
    if (updates.netsuiteCallbackSecret) {
      console.log(`Nuevo NETSUITE_CALLBACK_SECRET: ${updates.netsuiteCallbackSecret}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
