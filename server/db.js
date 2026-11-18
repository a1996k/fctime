import pg from 'pg';
import { env } from './env.js';

// Return DATE columns as 'YYYY-MM-DD' strings and TIME as 'HH:MM:SS'; never shift them through JS Dates.
pg.types.setTypeParser(1082, v => v);
pg.types.setTypeParser(1083, v => v);
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));

let pool = null;
export function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  return pool;
}
export function setDatabaseUrl(url) { env.DATABASE_URL = url; pool = null; }
export const query = (text, params) => getPool().query(text, params);
export async function one(text, params) { const r = await query(text, params); return r.rows[0] || null; }
export async function many(text, params) { const r = await query(text, params); return r.rows; }

/** Run fn inside a transaction. fn receives a client with query/one/many helpers. */
export async function tx(fn) {
  const client = await getPool().connect();
  const c = {
    query: (t, p) => client.query(t, p),
    one: async (t, p) => (await client.query(t, p)).rows[0] || null,
    many: async (t, p) => (await client.query(t, p)).rows,
  };
  try {
    await client.query('BEGIN');
    const out = await fn(c);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
export async function closePool() { if (pool) { const p = pool; pool = null; await p.end(); } }
