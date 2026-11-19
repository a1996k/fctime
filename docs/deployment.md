# Going live

How to run FifthColor Time for real people: what to host it on, how to configure it, the first sign-in, bringing Paymo history over, backups and upgrades.

## What you need

| | Requirement |
|---|---|
| **App server** | Node.js 20 or newer (22 LTS recommended) on Linux, with at least 1 GB of memory, or 2 GB if MySQL runs on the same machine. Any host that runs a Node process works: a VPS, or a platform such as Render, Railway or DigitalOcean App Platform. |
| **Database** | MySQL 8.0.16 or newer (MariaDB isn’t supported). A managed MySQL service or your existing MySQL server is fine. Five years of history for 30 people (about 140,000 entries) takes about 250 MB. |
| **Address** | A hostname (for example `time.fifthcolor.com`) served over **HTTPS**. Sign-in cookies are only safe over HTTPS. |

## 1. Database

Create a database and a user that can only reach it. Use a long random password.

```sql
CREATE USER 'fctime'@'%' IDENTIFIED BY 'a-long-random-password';
CREATE DATABASE fctime CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON fctime.* TO 'fctime'@'%';
```

Narrow `'%'` to the app server’s address if your MySQL setup allows it. Don’t expose MySQL’s port to the internet. The tables are created when the app first starts.

## 2. Install and configure

```bash
git clone https://github.com/a1996k/fctime.git /opt/fctime
```

```bash
cd /opt/fctime && npm ci --omit=dev
```

Create `/opt/fctime/.env` (keep it out of git; it holds the database password):

```
NODE_ENV=production
DATABASE_URL=mysql://fctime:a-long-random-password@db-host:3306/fctime
PORT=3000
COOKIE_SECURE=1
TRUST_PROXY=1
```

| Variable | Why |
|---|---|
| `NODE_ENV=production` | Refuses to load demo data or wipe the database, and refuses to start without `DATABASE_URL`. |
| `DATABASE_URL` | Where the database is. |
| `PORT` | The port the app listens on, behind your HTTPS proxy. Platforms usually set it for you. |
| `COOKIE_SECURE=1` | The sign-in cookie is only ever sent over HTTPS. The app also sets this flag automatically when it can tell the request came over HTTPS. |
| `TRUST_PROXY=1` | The app sits behind one proxy (nginx or a platform’s load balancer). It then sees each visitor’s real address, so the sign-in throttle slows down the right person, and it knows the request was HTTPS. Use the number of proxies in front of it. |

Don’t set `DEMO_PASSWORD`, and never run `npm run db:seed` or `npm run db:reset` against the live database. With `NODE_ENV=production` both refuse to run. Without it, the reset still refuses when the database holds anyone other than the demo users.

## 3. Run it behind HTTPS

**On a platform** (Render, Railway and similar), set the variables above in its settings, use `npm ci --omit=dev` as the build command and `npm start` as the start command, point its health check at `/healthz`, and add your domain. The platform provides HTTPS.

**On your own server**, keep the app running with systemd and put nginx in front for HTTPS. These are standard templates; adjust the paths and hostname.

`/etc/systemd/system/fctime.service`:

```ini
[Unit]
Description=FifthColor Time
After=network.target

[Service]
User=fctime
WorkingDirectory=/opt/fctime
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now fctime
```

nginx, with a certificate from Let’s Encrypt (`sudo certbot --nginx -d time.fifthcolor.com`):

```nginx
server {
  listen 443 ssl;
  server_name time.fifthcolor.com;
  ssl_certificate     /etc/letsencrypt/live/time.fifthcolor.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/time.fifthcolor.com/privkey.pem;

  client_max_body_size 45m;   # an admin's Paymo CSV upload; nginx's default of 1 MB would block it
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;  # a large import can take a minute
  }
}
server { listen 80; server_name time.fifthcolor.com; return 301 https://$host$request_uri; }
```

The app logs to standard output (`journalctl -u fctime -f`), applies new database migrations each time it starts, and finishes requests in flight before it stops on a restart. `GET /healthz` answers `{"ok":true}` for uptime checks.

## 4. The first admin

On an empty database, create yourself as the first admin from the server:

```bash
cd /opt/fctime && npm run admin:create -- --email you@fifthcolor.com --name "Your Name"
```

It asks for the password twice without showing it. Some hosting consoles have no interactive terminal; there, put the password in `ADMIN_PASSWORD` for that one command. The same command gets you back in if every admin is locked out: give an existing person’s email, and they become an active admin with the new password.

## 5. Set up the workspace

Sign in, then in this order:

1. **Settings → Company defaults:** time zone (dates and weeks follow it), rounding, budget alert.
2. **Settings → Service lines:** your real service lines, with bill rates, the department manager who gives the second approval, and the keywords that match Paymo task lists.
3. **Settings → People:** everyone, with role, department and a temporary password. Each person changes it by clicking their name at the top of any page. There’s no emailed password reset yet; an admin sets a new one.
4. **Clients and projects:** add them with their account owners, who give the first approval. The Paymo import can create them instead; set their account owners afterwards.

## 6. Bring Paymo history over

1. Import a short range first, such as last month, and compare the preview’s people, task-list mapping and hours with Paymo.
2. Bring the rest over. In the web app (Settings → Import from Paymo), one import takes up to 50,000 entries, about a year and a half for 30 people, so go a year at a time. From the server’s terminal there’s no limit, which suits a large first migration: `PAYMO_API_KEY=… npm run import:paymo -- --from 2022-01-01 --to 2026-11-30 --as you@fifthcolor.com`, then again with `--commit`. Five years for 30 people took 25 seconds in testing.
3. Run a pilot: a few people log a week, submit it, and take it through both approvals. Check the Time Reports total against what you expect.
4. At cutover, import once more to top up the time logged in Paymo since; nothing is duplicated. Then everyone switches.

## 7. Backups

Back up the database every night, keep about 30 days, and store copies off the server. Restore one into a scratch database once before going live, so you know it works. A managed MySQL service usually does this for you; otherwise, from cron:

```bash
mysqldump --single-transaction --no-tablespaces -h db-host -u fctime -p fctime | gzip > /backups/fctime-$(date +%F).sql.gz
```

To restore into an empty database: `gunzip < fctime-2026-11-19.sql.gz | mysql -h db-host -u fctime -p fctime`. To run it from cron without a password prompt, put the credentials in the backup user's `~/.my.cnf` (permissions 600).

## 8. Upgrades

Take a backup, then:

```bash
cd /opt/fctime && git pull && npm ci --omit=dev && sudo systemctl restart fctime
```

New migrations apply as it starts. Each migration file runs once, and the log names it.

## Go-live checklist

- [ ] HTTPS works, and `http://` redirects to it
- [ ] `.env` has `NODE_ENV=production`, `COOKIE_SECURE=1` and `TRUST_PROXY` set; no demo data in the database
- [ ] MySQL isn’t reachable from the internet; its user has rights to this database only
- [ ] First admin created with a strong password; a second admin added so one can’t be locked out alone
- [ ] Service lines, people, clients and account owners set up
- [ ] Paymo history imported and spot-checked against Paymo; a pilot week approved end to end
- [ ] Nightly backups running, and one restore tested
- [ ] An uptime check on `/healthz`

## Not in this version

These are in the [backlog](backlog.md). Decide whether you need any before switching everyone over:

- **Reopening approved time.** Approved time is final. If it’s wrong, the fix today is a new entry, which can only add time.
- **Email.** Notifications are in the app (the bell). Nothing is emailed, including password resets.
- **Single sign-on** with Google Workspace.
