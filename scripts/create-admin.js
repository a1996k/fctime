// Create the first admin on a new, empty database, or get admin access back:
//
//   npm run admin:create -- --email you@fifthcolor.com --name "Your Name"
//
// It asks for the password twice without showing it. With no terminal (some hosting consoles),
// it reads NEW_PASSWORD instead. If the email already belongs to someone, that person becomes an
// active admin with the new password, and every session they had is signed out.
import crypto from 'node:crypto';
import '../server/env.js';
import { migrate } from '../server/migrate.js';
import { one, query, closePool } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const die = async msg => { console.error(msg); await closePool(); process.exit(1); };

/** Read a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise(resolve => {
    const { stdin, stdout } = process;
    let value = '';
    const finish = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); stdout.write('\n'); };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); resolve(value); return; }
        if (ch === '\u0003') { finish(); process.exit(130); } // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdout.write(prompt);
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume();
    stdin.on('data', onData);
  });
}

const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
const name = typeof args.name === 'string' ? args.name.trim() : '';
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) await die('Give the admin’s email: npm run admin:create -- --email you@fifthcolor.com --name "Your Name"');
if (name.length > 120) await die('That name is too long (max 120 characters).');

await migrate({ log: () => {} }); // a brand-new database gets its tables first
const found = await one('SELECT id, name, email, role, archived_at FROM users WHERE lower(email) = $1', [email]);
const existing = found && found.email.toLowerCase() === email ? found : null; // exact address only
if (found && !existing) await die(`That address is too close to ${found.email}, which is already in use.`);
if (!existing && !name) await die('Nobody uses that email yet. Give their name too: --name "Your Name"');

let password = process.env.NEW_PASSWORD || '';
if (!password) {
  if (!process.stdin.isTTY) await die('There’s no terminal to ask for a password. Set NEW_PASSWORD for this one command instead.');
  password = await askHidden('Password (at least 8 characters): ');
  if (password !== await askHidden('Type it again: ')) await die('Those passwords don’t match. Nothing was changed.');
}
if (password.length < 8) await die('Use at least 8 characters. Nothing was changed.');

const hash = await hashPassword(password);
if (existing) {
  await query(`UPDATE users SET role = 'admin', archived_at = NULL, password_hash = $1 WHERE id = $2`, [hash, existing.id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [existing.id]);
  console.log(`${existing.name} (${email}) is now an active admin with the new password. Any sessions they had were signed out.`);
} else {
  await query(`INSERT INTO users (id, name, email, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)`, [crypto.randomUUID(), name, email, hash]);
  console.log(`Created admin ${name} (${email}). Sign in with that email and password.`);
}
await closePool();
