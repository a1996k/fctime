import { env, IS_PRODUCTION } from './env.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { closePool } from './db.js';
import { ensureBuiltinAdmin } from './builtin-admin.js';

await migrate({ log: m => console.log(`[db] ${m}`) });
try {
  await ensureBuiltinAdmin(m => console.log(`[admin] ${m}`));
} catch (e) {
  console.error(`[admin] ${e.message}`);
  process.exit(1);
}
const server = createApp().listen(env.PORT, () => {
  console.log(`FifthColor Time running at http://localhost:${env.PORT}`);
  if (IS_PRODUCTION && !env.COOKIE_SECURE && !process.env.TRUST_PROXY) {
    console.warn('[warn] Neither COOKIE_SECURE=1 nor TRUST_PROXY is set. Behind an HTTPS proxy, set one of them so sign-in cookies are marked Secure.');
  }
});

// On a deploy or restart, finish the requests in flight, then close the database pool.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${sig} received, shutting down`);
    setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => { await closePool().catch(() => {}); process.exit(0); });
  });
}
