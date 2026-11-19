import mysql from 'mysql2/promise';
import { env } from './env.js';

// MySQL 8 through mysql2. Every connection works in UTC, and DATE columns come back as 'YYYY-MM-DD'
// strings (never shifted through JS Dates). TINYINT(1) comes back as a boolean.
const typeCast = (field, next) => {
  if (field.type === 'TINY' && field.length === 1) { const v = field.string(); return v === null ? null : v === '1'; }
  return next();
};

let pool = null;
export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      uri: env.DATABASE_URL, connectionLimit: 10, waitForConnections: true,
      dateStrings: ['DATE'], timezone: 'Z', decimalNumbers: true, supportBigNumbers: true, typeCast,
    });
    // READ COMMITTED matches the locking the app relies on and avoids InnoDB gap-lock deadlocks.
    pool.pool.on('connection', conn => conn.query(`SET time_zone = '+00:00', SESSION transaction_isolation = 'READ-COMMITTED'`));
  }
  return pool;
}
export function setDatabaseUrl(url) { env.DATABASE_URL = url; pool = null; }

/**
 * Queries are written with numbered placeholders ($1, $2…) so one value can be used more than once.
 * This turns them into mysql2's positional `?`. An array value expands to a list for `IN ($1)`;
 * an empty one becomes (NULL), which matches nothing.
 */
export function toMysql(text, params = []) {
  const values = [];
  const sql = text.replace(/\$(\d+)/g, (_, n) => {
    const v = params[+n - 1];
    values.push(Array.isArray(v) && v.length === 0 ? [null] : v === undefined ? null : v);
    return '?';
  });
  return [sql, values];
}
const wrap = res => (Array.isArray(res) ? { rows: res, rowCount: res.length } : { rows: [], rowCount: res.affectedRows, insertId: res.insertId });

export async function query(text, params) {
  const [sql, values] = toMysql(text, params);
  const [res] = await getPool().query(sql, values);
  return wrap(res);
}
export async function one(text, params) { const r = await query(text, params); return r.rows[0] || null; }
export async function many(text, params) { const r = await query(text, params); return r.rows; }

/** Run fn inside a transaction, retrying a couple of times if InnoDB picks it as a deadlock victim. */
export async function tx(fn) {
  for (let attempt = 0; ; attempt++) {
    const conn = await getPool().getConnection();
    const run = async (t, p) => { const [sql, values] = toMysql(t, p); const [res] = await conn.query(sql, values); return wrap(res); };
    const c = { query: run, one: async (t, p) => (await run(t, p)).rows[0] || null, many: async (t, p) => (await run(t, p)).rows, raw: conn };
    try {
      await conn.beginTransaction();
      const out = await fn(c);
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback().catch(() => {});
      if ((e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < 2) continue;
      throw e;
    } finally {
      conn.release();
    }
  }
}
export async function closePool() { if (pool) { const p = pool; pool = null; await p.end(); } }
