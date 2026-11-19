import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { ROOT, env } from './env.js';

/**
 * Apply db/migrations/*.sql in order. Each file runs as one multi-statement batch on its own
 * connection. MySQL commits schema changes as it goes, so a failed migration can leave part of it
 * applied; fix the file and run again.
 */
export async function migrate({ reset = false, log = console.log } = {}) {
  const conn = await mysql.createConnection({ uri: env.DATABASE_URL, multipleStatements: true, timezone: 'Z' });
  try {
    await conn.query(`SET time_zone = '+00:00'`);
    if (reset) {
      const [tables] = await conn.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`);
      if (tables.length) {
        await conn.query(`SET FOREIGN_KEY_CHECKS = 0; DROP TABLE IF EXISTS ${tables.map(r => conn.escapeId(r.t)).join(', ')}; SET FOREIGN_KEY_CHECKS = 1;`);
      }
      log('Dropped all tables.');
    }
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(200) PRIMARY KEY, applied_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)))`);
    const [done] = await conn.query('SELECT name FROM schema_migrations');
    const applied = new Set(done.map(r => r.name));
    const dir = path.join(ROOT, 'db', 'migrations');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (applied.has(f)) continue;
      await conn.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
      log(`Applied ${f}`);
    }
  } finally {
    await conn.end();
  }
}
