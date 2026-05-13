// Request-scoped context for the admin UI. Lets view helpers like
// `fmtDate` pick up the current admin's preferred display timezone without
// threading it as an argument through every callsite.

import { AsyncLocalStorage } from 'node:async_hooks';

export type AdminContext = {
  displayTz: string;
};

export const adminContextStorage = new AsyncLocalStorage<AdminContext>();

export function getDisplayTz(fallback: string): string {
  return adminContextStorage.getStore()?.displayTz ?? fallback;
}
