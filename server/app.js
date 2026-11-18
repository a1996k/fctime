import path from 'node:path';
import express from 'express';
import { ROOT } from './env.js';
import { loadUser, requireJson } from './auth.js';
import { HttpError } from './http.js';
import core from './routes/core.js';
import tasks from './routes/tasks.js';
import time from './routes/time.js';
import reports from './routes/reports.js';
import notifications from './routes/notifications.js';
import importer from './routes/import.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  // CSV uploads for the Paymo import can be large; everything else stays small.
  const smallJson = express.json({ limit: '200kb' }), bigJson = express.json({ limit: '40mb' });
  api.use((req, res, next) => (req.path === '/import/paymo/csv' ? bigJson : smallJson)(req, res, next));
  api.use(requireJson);
  api.use(loadUser);
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(core, tasks, time, reports, notifications, importer);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  api.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'That request wasn’t valid JSON.');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'That request is too large.');
    // Database constraint errors are bad input, not server faults.
    const PG = { 23505: [409, 'That already exists.'], 23503: [400, 'That refers to something that doesn’t exist.'], 23514: [400, 'That value isn’t allowed.'],
      '22P02': [400, 'That value isn’t valid.'], 22003: [400, 'That number is out of range.'], 22007: [400, 'That date or time isn’t valid.'], 22008: [400, 'That date or time isn’t valid.'] };
    if (err.code && PG[err.code]) err = new HttpError(...PG[err.code]);
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message, ...(err.extra || {}) });
  });
  app.use('/api', api);

  const pub = path.join(ROOT, 'public');
  app.use(express.static(pub, { index: false, maxAge: 0 }));
  // single-page app: everything else gets index.html
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(pub, 'index.html')));
  return app;
}
