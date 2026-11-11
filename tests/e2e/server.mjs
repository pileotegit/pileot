// Lokaler Ende-zu-Ende-Server: statische Seiten aus web/ und Handler unter /functions/v1/*,
// gegen eine frische Postgres-Datenbank. Gibt nach dem Start JSON mit Test-Links aus.
import http from 'node:http';
import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fakeResend, makeDeps } from '../functions/fakes.mjs';
import { handler as click } from '../../supabase/functions/rv-click/handler.ts';
import { handler as unsub } from '../../supabase/functions/rv-unsubscribe/handler.ts';
import { handler as jobs } from '../../supabase/functions/rv-jobs/handler.ts';

const PORT = Number(process.env.E2E_PORT ?? 8787);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const base = { host: process.env.PGHOST ?? '/tmp', port: Number(process.env.PGPORT ?? 54329), user: 'pgtest' };
const db = 'rve2e_' + Date.now();
const root = new URL('../../', import.meta.url).pathname;

const admin = new pg.Client({ ...base, database: 'postgres' });
await admin.connect();
await admin.query(`create database ${db}`);
await admin.end();
const c = new pg.Client({ ...base, database: db });
await c.connect();
await c.query(readFileSync(join(root, 'tests/db/bootstrap.sql'), 'utf8'));
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await c.query(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
const svc = new pg.Client({ ...base, database: db, options: '-c role=service_role' });
await svc.connect();

const setup = (await svc.query(`select public.rv_setup_tenant('Kosmetikstudio Beispiel', 'Kosmetikstudio Beispiel', 'https://g.page/r/BEISPIEL/review',
  'Kosmetikstudio Beispiel', 'bewertung@mail.example.test', 'studio@example.test', 'studio@example.test') as r`)).rows[0].r;
await svc.query(`select public.rv_set_tenant_status($1, 'active')`, [setup.tenant_id]);
await svc.query(`select public.rv_set_test_mode($1, false)`, [setup.tenant_id]);
await svc.query(`select public.rv_set_global_send_paused(false)`);
await c.query(`update review.tenant_settings set send_window_start='00:00', send_window_end='24:00', send_weekdays='{1,2,3,4,5,6,7}'`);
const key = (await svc.query(`select public.rv_create_integration($1, $2, 'e2e') as k`, [setup.tenant_id, setup.location_id])).rows[0].k;
const ing = (await svc.query(`select public.rv_ingest_completion($1, 'e2e-1', 'k1', 'kundin@example.test', 'Anna', now(), 'explicit_opt_in', 'E2E', now()) as r`, [key])).rows[0].r;
await c.query(`update review.send_jobs set due_at = now() - interval '1 minute'`);

const resend = fakeResend();
const { deps } = makeDeps(svc, {
  fetch: resend.fetch,
  env: { CLICK_PAGE_URL: `${ORIGIN}/r/`, UNSUB_PAGE_URL: `${ORIGIN}/abmelden/`, ALLOWED_ORIGINS: ORIGIN, FUNCTIONS_BASE_URL: `${ORIGIN}/functions/v1` },
});
await jobs(new Request(`${ORIGIN}/functions/v1/rv-jobs`, { method: 'POST', headers: { 'x-rv-worker-secret': deps.env.WORKER_SECRET }, body: '{"action":"send"}' }), deps);
const mail = resend.sent[0];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/__mail.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(mail.html); }
  if (url.pathname === '/__state') {
    const s = (await c.query(`select (select json_agg(json_build_object('kind', kind, 'status', status)) from review.send_jobs) jobs,
      (select json_agg(click_class) from review.click_events) clicks, (select count(*)::int from review.suppressions) supp,
      (select status || ':' || coalesce(end_reason,'') from review.campaigns limit 1) camp`)).rows[0];
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(s));
  }
  if (url.pathname.startsWith('/functions/v1/')) {
    const name = url.pathname.split('/')[3];
    const h = { 'rv-click': click, 'rv-unsubscribe': unsub }[name];
    if (!h) { res.writeHead(404); return res.end(); }
    const chunks = []; for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await h(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), deps);
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = normalize(url.pathname).replace(/^\/+/, '');
  if (p === '' || p.endsWith('/')) p += 'index.html';
  const file = join(root, 'web', p);
  if (!file.startsWith(join(root, 'web')) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  let content = readFileSync(file);
  if (p === 'config.js') content = Buffer.from(`window.RV_CONFIG = { apiBase: '${ORIGIN}/functions/v1' };`);
  if (p.endsWith('.html')) content = Buffer.from(content.toString().replace('connect-src https://*.supabase.co', `connect-src ${ORIGIN}`));
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  res.end(content);
});
server.listen(PORT, '127.0.0.1', () => {
  const click = mail.text.match(/http:\/\/127\.0\.0\.1:\d+\/r\/\?t=[0-9a-f]{64}/)[0];
  const unsubUrl = mail.text.match(/http:\/\/127\.0\.0\.1:\d+\/abmelden\/\?t=[0-9a-f]{64}/)[0];
  console.log(JSON.stringify({ ready: true, click, unsub: unsubUrl, campaign: ing.campaign_id, db }));
});
process.on('SIGTERM', async () => { server.close(); await c.end(); await svc.end(); process.exit(0); });
