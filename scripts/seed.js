import { env, IS_PRODUCTION } from '../server/env.js';
import { migrate } from '../server/migrate.js';
import { seedDemo } from '../server/seed.js';
import { closePool } from '../server/db.js';

// Demo users all share one published password, so they never belong on a live server.
if (IS_PRODUCTION) {
  console.error('Refusing to load demo data: NODE_ENV is production. Use `npm run admin:create` to add the first admin.');
  process.exit(1);
}
try {
  await migrate();
  await seedDemo({ password: env.DEMO_PASSWORD });
  console.log('Demo password for every user: ' + env.DEMO_PASSWORD);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
