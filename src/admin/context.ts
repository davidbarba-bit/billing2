// Request-scoped context for the admin UI. Lets view helpers like
// `fmtDate` pick up the current admin's preferred display timezone without
// threading it as an argument through every callsite.

import { AsyncLocalStorage } from 'node:async_hooks';

export type AdminUser = {
  email: string;
  name: string;
  picture: string | null;
};

export type AdminContext = {
  displayTz: string;
  // v16: usuario autenticado vía Google (si auth mode es google y hay sesión).
  user?: AdminUser | null;
};

export const adminContextStorage = new AsyncLocalStorage<AdminContext>();

export function getDisplayTz(fallback: string): string {
  return adminContextStorage.getStore()?.displayTz ?? fallback;
}

export function getCurrentAdminUser(): AdminUser | null {
  return adminContextStorage.getStore()?.user ?? null;
}
