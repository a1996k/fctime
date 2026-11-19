import { IS_PRODUCTION } from '../server/env.js';
import { migrate } from '../server/migrate.js';
import { closePool, many } from '../server/db.js';
import { DEMO_USERS } from '../server/seed.js';

const reset = process.argv.includes('--reset'), force = process.argv.includes('--force');
if (reset) {
  if (IS_PRODUCTION) {
    console.error('Refusing to drop tables: NODE_ENV is production.');
    process.exit(1);
  }
  // Only throw away a database that holds nothing but demo data, unless told to.
  const demo = new Set([...DEMO_USERS.map(u => u.email), 'admin']); // the built-in admin comes back from .env
  let others = [];
  try { others = (await many('SELECT email FROM users')).map(r => r.email).filter(e => !demo.has(e)); } catch { /* new database: no users table yet */ }
  if (others.length && !force) {
    console.error(`This database has ${others.length === 1 ? 'someone who isn’t a demo user' : `${others.length} people who aren’t demo users`} (for example ${others[0]}). Resetting deletes all of its data.`);
    console.error('If you really mean to wipe it, run: node scripts/migrate.js --reset --force');
    await closePool();
    process.exit(1);
  }
}
await migrate({ reset });
await closePool();
