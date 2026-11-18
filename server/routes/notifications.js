// The bell: list, count and mark notifications read. Only ever your own.
import { Router } from 'express';
import { one, many, query } from '../db.js';
import { h, bad } from '../http.js';
import { requireUser } from '../auth.js';
import { getSettings } from '../domain.js';
import { dueReminders } from '../notify.js';

const r = Router();
r.use(requireUser);
const db = { query, one, many };

/** Create any due-date reminders the person is owed, then return the unread count. */
export async function refreshAndCount(userId) {
  const s = await getSettings();
  await dueReminders(db, userId, s.today);
  return (await one('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId])).n;
}

r.get('/notifications', h(async (req, res) => {
  const unread = await refreshAndCount(req.user.id);
  if (req.query.count) return res.json({ unread, today: (await getSettings()).today });
  const items = await many(`SELECT id, type, title, body, link, read_at, created_at FROM notifications
                             WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 60`, [req.user.id]);
  res.json({ unread, items });
}));

r.post('/notifications/read', h(async (req, res) => {
  const { ids, all } = req.body;
  if (all) await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  else {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(i => Number.isInteger(i))) throw bad('Choose notifications to mark read.');
    await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [req.user.id, ids]);
  }
  res.json({ unread: (await one('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id])).n });
}));

export default r;
