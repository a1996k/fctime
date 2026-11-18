import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';
import { query, tx } from './db.js';

export async function migrate({ reset = false, log = console.log } = {}) {
  if (reset) {
    await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    log('Dropped all tables.');
  }
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const dir = path.join(ROOT, 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await tx(async c => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    log(`Applied ${f}`);
  }
}
