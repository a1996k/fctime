import { env } from './env.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';

await migrate({ log: m => console.log(`[db] ${m}`) });
createApp().listen(env.PORT, () => console.log(`FifthColor Time running at http://localhost:${env.PORT}`));
