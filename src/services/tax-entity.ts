// v22: helpers de razones sociales (TaxEntity).
//
// La identidad fiscal vive en TaxEntity, no en el Customer. Cada fila
// facturable (service, customer_add_on, catalog_event_occurrence, invoice)
// referencia una razón social vía tax_entity_id (NOT NULL). Mientras la UI
// de fases 2/4 no permita elegir otra, todo hereda la razón social DEFAULT
// del cliente — que se resuelve con este helper.

import type { Prisma, PrismaClient } from '@prisma/client';

type TaxEntityDb = PrismaClient | Prisma.TransactionClient;

// Devuelve el id de la razón social default del cliente. Todo cliente tiene
// exactamente una (garantizado al crear el cliente y por el back-fill de la
// migración v22). Lanza si no existe — eso sería un invariante roto.
export async function resolveDefaultTaxEntityId(db: TaxEntityDb, customerId: string): Promise<string> {
  const te = await db.taxEntity.findFirst({
    where: { customerId, isDefault: true },
    select: { id: true },
  });
  if (!te) {
    throw new Error(`customer ${customerId} has no default tax entity (v22 invariant violated)`);
  }
  return te.id;
}
