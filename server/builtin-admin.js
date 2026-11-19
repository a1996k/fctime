// The built-in admin login: username “admin”, with the password from ADMIN_PASSWORD in .env.
// Applied each time the server starts. The account is created if it's missing, its password follows
// .env, and it stays an active admin. Remove ADMIN_PASSWORD to manage the account in the app instead.
import crypto from 'node:crypto';
import { one, query } from './db.js';
import { env } from './env.js';
import { hashPassword, verifyPassword } from './auth.js';

export const BUILTIN_LOGIN = 'admin';
const MIN_LENGTH = 12;

/** True for the built-in admin while .env controls it. */
export const isBuiltinManaged = u => !!env.ADMIN_PASSWORD && !!u && String(u.email).toLowerCase() === BUILTIN_LOGIN;

export async function ensureBuiltinAdmin(log = console.log) {
  const pw = env.ADMIN_PASSWORD;
  if (!pw) return;
  // Everyone knows the username, so the password has to carry the weight.
  if (pw.length < MIN_LENGTH) throw new Error(`ADMIN_PASSWORD in .env must be at least ${MIN_LENGTH} characters. The admin login wasn’t set up.`);
  if (pw === env.DEMO_PASSWORD || pw === 'fifthcolor-demo') throw new Error('ADMIN_PASSWORD can’t be the published demo password. Choose another.');
  const u = await one('SELECT id, email, role, archived_at, password_hash FROM users WHERE email = $1', [BUILTIN_LOGIN]);
  if (!u) {
    await query(`INSERT INTO users (id, name, email, role, password_hash) VALUES ($1, 'Admin', $2, 'admin', $3)`, [crypto.randomUUID(), BUILTIN_LOGIN, await hashPassword(pw)]);
    log('Admin login created: sign in with username “admin” and ADMIN_PASSWORD.');
    return;
  }
  if (!(await verifyPassword(pw, u.password_hash))) {
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(pw), u.id]);
    await query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    log('Admin login: password updated from ADMIN_PASSWORD; its old sessions were signed out.');
  }
  if (u.role !== 'admin' || u.archived_at) await query(`UPDATE users SET role = 'admin', archived_at = NULL WHERE id = $1`, [u.id]);
}
