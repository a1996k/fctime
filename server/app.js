import path from 'node:path';
import express from 'express';
import compression from 'compression';
import { ROOT } from './env.js';
import { loadUser, requireJson } from './auth.js';
import { HttpError } from './http.js';
import core from './routes/core.js';
import tasks from './routes/tasks.js';
import time from './routes/time.js';
import reports from './routes/reports.js';
import notifications from './routes/notifications.js';
import importer from './routes/import.js';

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy, set TRUST_PROXY (for example "1" or the proxy's address) so req.ip is the client's.
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', !tp ? 'loopback' : /^\d+$/.test(tp) ? +tp : tp === 'true' ? true : tp);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // Only the app's own scripts run; styles and fonts also come from Google Fonts (Inter).
    res.setHeader('Content-Security-Policy', CSP);
    // Over HTTPS, tell browsers to keep using it. Subdomains are left alone; they may be other sites.
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // Gzip responses: a year's report is mostly repeated names, so it shrinks to a fraction on the wire.
  app.use(compression());
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  // CSV uploads for the Paymo import can be large; everything else stays small.
  // Who's asking is known before any body is read: only a signed-in admin's CSV upload may be large,
  // so nobody else can make the server read and parse big requests.
  api.use(requireJson);
  api.use(loadUser);
  const smallJson = express.json({ limit: '200kb' }), bigJson = express.json({ limit: '40mb' });
  api.use((req, res, next) => (req.path === '/import/paymo/csv' && req.user && req.user.role === 'admin' ? bigJson : smallJson)(req, res, next));
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(core, tasks, time, reports, notifications, importer);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  api.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'That request wasn’t valid JSON.');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'That request is too large.');
    // Database constraint errors are bad input, not server faults.
    const DB = {
      ER_DUP_ENTRY: [409, 'That already exists.'],
      ER_NO_REFERENCED_ROW: [400, 'That refers to something that doesn’t exist.'], ER_NO_REFERENCED_ROW_2: [400, 'That refers to something that doesn’t exist.'],
      ER_ROW_IS_REFERENCED_2: [409, 'Something else still uses that.'],
      ER_CHECK_CONSTRAINT_VIOLATED: [400, 'That value isn’t allowed.'], ER_BAD_NULL_ERROR: [400, 'A required value is missing.'],
      ER_TRUNCATED_WRONG_VALUE: [400, 'That value isn’t valid.'], ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: [400, 'That value isn’t valid.'],
      ER_WRONG_VALUE: [400, 'That value isn’t valid.'], ER_INVALID_JSON_TEXT: [400, 'That value isn’t valid.'],
      ER_WARN_DATA_OUT_OF_RANGE: [400, 'That number is out of range.'], ER_DATA_TOO_LONG: [400, 'That text is too long.'],
      ER_NET_PACKET_TOO_LARGE: [413, 'That is too large for the database. Split the file, or raise MySQL’s max_allowed_packet.'],
    };
    if (err.code && DB[err.code]) err = new HttpError(...DB[err.code]);
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
