// Vitest setup: load .env.test if present and force NODE_ENV=test.

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';

process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://numaris:numaris@localhost:5432/numaris_billing_test?schema=public';
}
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'silent';
}
if (existsSync('.env.test')) {
  loadDotenv({ path: '.env.test' });
}
