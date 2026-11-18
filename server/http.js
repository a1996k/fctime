// Small helpers for consistent JSON errors.
export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const forbidden = (msg = 'You don’t have access to do that.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);

/** Wrap an async route handler so thrown errors reach the error middleware. */
export const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const isUUID = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function uuidParam(v, label = 'id') { if (!isUUID(v)) throw bad(`Invalid ${label}.`); return v; }
export function str(v, { label, max = 500, required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (required && !s) throw bad(`${label} is required.`, { field: label });
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters).`, { field: label });
  return s;
}
