import '../server/env.js';
import { migrate } from '../server/migrate.js';
import { closePool } from '../server/db.js';

await migrate({ reset: process.argv.includes('--reset') });
await closePool();
