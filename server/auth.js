import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from './db.js';
import { env } from './env.js';
import { HttpError, forbidden } from './http.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'fct_sid';
const SESSION_DAYS = 14;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, k] = stored.split('$');
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const want = Buffer.from(k, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setCookie(res, value, maxAgeSec) {
  const bits = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (env.COOKIE_SECURE) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha(token), userId]);
  setCookie(res, token, SESSION_DAYS * 86400);
}
export async function destroySession(req, res) {
  const t = readCookie(req, COOKIE);
  if (t) await query('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
  setCookie(res, '', 0);
}

/** Attach req.user when the session cookie is valid. */
export async function loadUser(req, _res, next) {
  try {
    const t = readCookie(req, COOKIE);
    if (t) {
      req.user = await one(
        `SELECT u.id, u.name, u.email, u.role, u.dept_id, u.capacity
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now() AND u.archived_at IS NULL`, [sha(t)]);
    }
    next();
  } catch (e) { next(e); }
}
export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  next();
}
export function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  if (req.user.role !== 'admin') return next(forbidden('Only admins can do that.'));
  next();
}

/** Mutating API calls must be JSON; browsers can’t send cross-site JSON without a CORS preflight, so this blocks CSRF. */
export function requireJson(req, _res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return next(new HttpError(415, 'Send requests as JSON.'));
  }
  next();
}

// Simple in-memory throttle for sign-in attempts.
const attempts = new Map();
export function throttleLogin(key) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const a = (attempts.get(key) || []).filter(t => now - t < win);
  if (a.length >= 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.');
  a.push(now); attempts.set(key, a);
}
export function clearLoginThrottle(key) { attempts.delete(key); }
