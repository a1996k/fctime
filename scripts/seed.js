import { env } from '../server/env.js';
import { migrate } from '../server/migrate.js';
import { seedDemo } from '../server/seed.js';
import { closePool } from '../server/db.js';

await migrate();
await seedDemo({ password: env.DEMO_PASSWORD });
console.log('Demo password for every user: ' + env.DEMO_PASSWORD);
await closePool();
