// Time helpers shared by the server and the browser. Durations are whole minutes.
// Dates are 'YYYY-MM-DD' strings in the workspace time zone; weeks start on Monday.

/** Parse '1:30', '1.5', '1.5h', '90m' or '90 min' into whole minutes. Returns null when invalid. */
export function parseDuration(s) {
  s = String(s ?? '').trim();
  let m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
  m = s.match(/^(\d*\.?\d+)\s*h?$/i);
  if (m) return Math.round(parseFloat(m[1]) * 60);
  m = s.match(/^(\d+)\s*m(in)?$/i);
  if (m) return +m[1];
  return null;
}

/** Wireframe rule: round timer entries up to the configured step (0 = no rounding). */
export function roundUp(minutes, step) {
  step = +step || 0;
  return step ? Math.ceil(minutes / step) * step : minutes;
}

/** 'HH:MM' (or 'HH:MM:SS') to minutes after midnight, or null. */
export function fromHM(s) {
  if (!s || !/^\d{1,2}:\d{2}/.test(s)) return null;
  const [a, b] = s.split(':').map(Number);
  if (a > 24 || b > 59 || (a === 24 && b > 0)) return null;
  return a * 60 + b;
}
export const toHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const hm = min => { min = Math.round(min || 0); return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`; };

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Monday = 0 … Sunday = 6 */
export function dow(iso) { return (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7; }
export const weekStart = iso => addDays(iso, -dow(iso));
export const weekDays = ws => [...Array(7)].map((_, i) => addDays(ws, i));
export const isISODate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

/** Do two same-day ranges [a1,a2) and [b1,b2) overlap? Inputs in minutes. */
export const rangesOverlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
