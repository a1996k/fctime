// Minimal .env loader so the app runs on Node 20+ without extra packages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
export const ROOT = root;
export const env = {
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://fctime:fctime@localhost:5432/fctime',
  PORT: +(process.env.PORT || 3000),
  COOKIE_SECURE: process.env.COOKIE_SECURE === '1',
  DEMO_PASSWORD: process.env.DEMO_PASSWORD || 'fifthcolor-demo',
};
