import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDb } from '../db/helpers.mjs';
import { ENV, fakeResend, jsonReq, makeDeps } from './fakes.mjs';
import { handler as ingestHandler } from '../../supabase/functions/rv-ingest/handler.ts';
import { handler as jobsHandler } from '../../supabase/functions/rv-jobs/handler.ts';
import { handler as clickHandler, isAllowedTarget } from '../../supabase/functions/rv-click/handler.ts';
import { handler as unsubHandler } from '../../supabase/functions/rv-unsubscribe/handler.ts';
import { handler as webhookHandler, mapEvent } from '../../supabase/functions/rv-resend-webhook/handler.ts';
import { sign } from '../../supabase/functions/_shared/svix.ts';
import { renderRequest } from '../../supabase/functions/_shared/templates.ts';
import { normalizeReview } from '../../supabase/functions/_shared/google.ts';

const F = ENV.FUNCTIONS_BASE_URL;
const now = () => new Date().toISOString();

const ingestBody = (o = {}) => ({
  event_id: o.event_id ?? 'termin-' + Math.random().toString(16).slice(2),
  contact_ref: o.contact_ref ?? 'kundin-' + Math.random().toString(16).slice(2),
  email: o.email ?? `k${Math.random().toString(16).slice(2)}@example.test`,
  first_name: o.first_name ?? 'Anna',
  completed_at: o.completed_at ?? now(),
  consent: o.consent === undefined ? { basis: 'explicit_opt_in', source: 'Anmeldeformular', documented_at: now() } : o.consent,
});

const work = (deps, action) =>
  jobsHandler(jsonReq(`${F}/rv-jobs`, { action }, { 'x-rv-worker-secret': ENV.WORKER_SECRET }), deps).then((r) => r.json());

async function ingestDue(c, deps, apiKey, o) {
  const res = await ingestHandler(jsonReq(`${F}/rv-ingest`, ingestBody(o), { authorization: `Bearer ${apiKey}` }), deps);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  await c.makeDue(body.job_id);
  return body;
}

const tokenFrom = (url) => new URL(url).searchParams.get('t');
const clickUrlOf = (mail) => mail.text.match(/https:\/\/link\.example\.test\/r\/\?t=[0-9a-f]{64}/)[0];
const unsubUrlOf = (mail) => mail.text.match(/https:\/\/link\.example\.test\/abmelden\/\?t=[0-9a-f]{64}/)[0];

// ---------------------------------------------------------------------------

withDb('rv-ingest: Authentifizierung, Idempotenz, Ablehnungen mit Status', async (c) => {
  const s = await c.seed();
  const { deps } = makeDeps(c.svc);
  const call = (body, auth = `Bearer ${s.apiKey}`) => ingestHandler(jsonReq(`${F}/rv-ingest`, body, auth ? { authorization: auth } : {}), deps);

  assert.equal((await call(ingestBody(), null)).status, 401);
  assert.equal((await call(ingestBody(), 'Bearer rvk_' + '0'.repeat(64))).status, 401);
  const b = ingestBody();
  assert.equal((await call(b)).status, 201);
  const dup = await call(b);
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).result, 'duplicate');
  const nc = await call(ingestBody({ consent: null }));
  assert.equal(nc.status, 422);
  assert.equal((await nc.json()).reason, 'no_consent');
  assert.equal((await call(ingestBody({ completed_at: 'gestern' }))).status, 422);
  const big = ingestHandler(new Request(`${F}/rv-ingest`, { method: 'POST', headers: { authorization: `Bearer ${s.apiKey}`, 'content-length': '100000' }, body: 'x'.repeat(100000) }), deps);
  assert.equal((await big).status, 413);
});

withDb('rv-jobs: ohne gültiges Worker-Secret passiert nichts', async (c) => {
  await c.seed();
  const { deps } = makeDeps(c.svc);
  const r1 = await jobsHandler(jsonReq(`${F}/rv-jobs`, { action: 'send' }), deps);
  assert.equal(r1.status, 401);
  const r2 = await jobsHandler(jsonReq(`${F}/rv-jobs`, { action: 'send' }, { 'x-rv-worker-secret': 'falsch' }), deps);
  assert.equal(r2.status, 401);
  const weak = makeDeps(c.svc, { env: { WORKER_SECRET: 'kurz' } }).deps;
  const r3 = await jobsHandler(jsonReq(`${F}/rv-jobs`, { action: 'send' }, { 'x-rv-worker-secret': 'kurz' }), weak);
  assert.equal(r3.status, 401, 'zu kurzes Secret wird nie akzeptiert');
});

withDb('Versand Ende zu Ende: eine Mail mit korrekten Headern, Idempotenzschlüssel, Erinnerung geplant, kein Doppelversand', async (c) => {
  const s = await c.seed();
  const resend = fakeResend();
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  const ing = await ingestDue(c, deps, s.apiKey, { first_name: 'Anna', email: 'anna@example.test' });

  const r = await work(deps, 'send');
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.equal(resend.sent.length, 1);
  const m = resend.sent[0];
  assert.deepEqual(m.to, ['anna@example.test']);
  assert.equal(m.from, '"Studio" <bewertung@mail.example.test>');
  assert.deepEqual(m.reply_to, ['inhaberin@example.test']);
  assert.equal(m.key, `rv-${ing.campaign_id}-initial`);
  assert.match(m.subject, /Wie war Ihr Termin bei Studio\?/);
  assert.match(m.text, /Hallo Anna,/);
  assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/ref\.supabase\.co\/functions\/v1\/rv-unsubscribe\?t=[0-9a-f]{64}>$/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(m.tags.some((t) => t.name === 'rv' && t.value === 'job'));
  assert.ok(!/<script/i.test(m.html));

  const job = await c.one(`select status, provider_message_id from review.send_jobs where kind = 'initial'`);
  assert.deepEqual([job.status, job.provider_message_id], ['sent', 'msg_1']);
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'queued'`), 1);

  assert.equal((await work(deps, 'send')).sent, 0);
  assert.equal(resend.calls, 1, 'kein zweiter Provider-Aufruf');
});

withDb('Timeout nach Annahme durch den Provider: sofortige Wiederholung mit gleichem Schlüssel, genau eine Mail', async (c) => {
  const s = await c.seed();
  const resend = fakeResend((n) => (n === 1 ? 'timeout-after-accept' : 'ok'));
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  await ingestDue(c, deps, s.apiKey);
  const r = await work(deps, 'send');
  assert.equal(r.sent, 1);
  assert.equal(resend.sent.length, 1, 'Provider hat nur eine Mail angenommen');
  assert.equal(resend.calls, 2);
});

withDb('Dauerhaft unklarer Ausgang: Job "unknown", kein weiterer Versand, Warnung im Betrieb', async (c) => {
  const s = await c.seed();
  const resend = fakeResend(() => 'timeout');
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  await ingestDue(c, deps, s.apiKey);
  const r = await work(deps, 'send');
  assert.equal(r.unknown, 1);
  assert.equal((await c.one(`select status from review.send_jobs`)).status, 'unknown');
  const calls = resend.calls;
  await work(deps, 'send');
  assert.equal(resend.calls, calls, 'unknown wird nicht automatisch erneut gesendet');
  const ops = await work(deps, 'ops');
  assert.ok(ops.alerts.some((a) => a.code === 'unknown_jobs'));
});

withDb('Provider lehnt API-Key ab (401): globale Pause, alle Jobs zurück, Warnung', async (c) => {
  const s = await c.seed();
  const resend = fakeResend(() => 401);
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  await ingestDue(c, deps, s.apiKey);
  await ingestDue(c, deps, s.apiKey);
  const r = await work(deps, 'send');
  assert.equal(r.aborted, 'config_error');
  assert.equal(resend.calls, 1, 'nach dem ersten 401 kein weiterer Versuch');
  const jobs = (await c.root.query(`select status, attempts from review.send_jobs order by created_at`)).rows;
  assert.deepEqual(jobs.map((j) => [j.status, j.attempts]), [['queued', 0], ['queued', 0]]);
  assert.equal((await c.one('select send_paused from review.system_settings')).send_paused, true);
});

withDb('429 wird später wiederholt, 422 beendet die Kampagne', async (c) => {
  const s = await c.seed();
  let mode = 429;
  const resend = fakeResend(() => mode);
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  const a = await ingestDue(c, deps, s.apiKey);
  assert.equal((await work(deps, 'send')).transient, 1);
  assert.equal((await c.one('select status from review.send_jobs where id = $1', [a.job_id])).status, 'queued');
  mode = 422;
  await c.makeDue(a.job_id);
  assert.equal((await work(deps, 'send')).permanent, 1);
  const camp = await c.one('select status, end_reason from review.campaigns where id = $1', [a.campaign_id]);
  assert.deepEqual([camp.status, camp.end_reason], ['stopped', 'send_failed']);
});

withDb('Klick: Seite geladen stoppt nichts, Button liefert nur geprüfte Google-URL, CORS nur für eigene Seite', async (c) => {
  const s = await c.seed();
  const resend = fakeResend();
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  await ingestDue(c, deps, s.apiKey);
  await work(deps, 'send');
  const t = tokenFrom(clickUrlOf(resend.sent[0]));

  const get = await clickHandler(new Request(`${F}/rv-click?t=${t}`), deps);
  assert.equal(get.status, 303);
  assert.equal(get.headers.get('location'), `https://link.example.test/r/?t=${t}`);
  assert.equal(await c.count(`select count(*) n from review.click_events`), 0, 'GET registriert nichts');

  const origin = { origin: 'https://link.example.test' };
  const raw = await clickHandler(jsonReq(`${F}/rv-click`, { t, class: 'raw' }, origin), deps);
  assert.equal(raw.headers.get('access-control-allow-origin'), 'https://link.example.test');
  assert.deepEqual(await raw.json(), { valid: true, studio: 'Studio' });
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'queued'`), 1);

  const q = await clickHandler(jsonReq(`${F}/rv-click`, { t, class: 'qualified' }, { origin: 'https://evil.example' }), deps);
  assert.equal(q.headers.get('access-control-allow-origin'), null);
  assert.equal((await q.json()).url, 'https://g.page/r/ABC123/review');
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'cancelled'`), 1);

  const bad = await clickHandler(jsonReq(`${F}/rv-click`, { t: 'a'.repeat(64), class: 'qualified' }), deps);
  assert.equal(bad.status, 404);
  assert.deepEqual(await bad.json(), { valid: false });

  assert.equal(isAllowedTarget('https://g.page/r/x'), true);
  assert.equal(isAllowedTarget('https://g.page.evil.com/x'), false);
  assert.equal(isAllowedTarget('https://user@g.page/x'), false);
  assert.equal(isAllowedTarget('http://g.page/x'), false);
});

withDb('Abmeldung: GET ändert nichts, One-Click-POST (RFC 8058) meldet ab, danach kein Versand', async (c) => {
  const s = await c.seed();
  const resend = fakeResend();
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  await ingestDue(c, deps, s.apiKey);
  await work(deps, 'send');
  const m = resend.sent[0];
  const oneClick = m.headers['List-Unsubscribe'].slice(1, -1);
  const t = tokenFrom(unsubUrlOf(m));

  const get = await unsubHandler(new Request(oneClick), deps);
  assert.equal(get.status, 303);
  assert.equal(await c.count('select count(*) n from review.suppressions'), 0);

  const check = await unsubHandler(jsonReq(`${F}/rv-unsubscribe`, { t, action: 'check' }), deps);
  assert.deepEqual(await check.json(), { valid: true });
  assert.equal(await c.count('select count(*) n from review.suppressions'), 0);

  const post = await unsubHandler(new Request(oneClick, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  }), deps);
  assert.equal(post.status, 200);
  assert.equal(await c.count('select count(*) n from review.suppressions'), 1);
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'cancelled'`), 1);

  const wrongBody = await unsubHandler(new Request(oneClick, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'foo=bar',
  }), deps);
  assert.equal(wrongBody.status, 400);
});

withDb('Resend-Webhook: Signatur, Zeitfenster, Idempotenz, Bounce sperrt, unbekannte Job-Mail wird erneut zugestellt', async (c) => {
  const s = await c.seed();
  const resend = fakeResend();
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  await ingestDue(c, deps, s.apiKey);
  await work(deps, 'send');
  const msgId = 'msg_1';

  const hook = async (payload, { id = 'evt_' + Math.random().toString(16).slice(2), ts = Math.floor(Date.now() / 1000), tamper = false } = {}) => {
    const body = JSON.stringify(payload);
    const sig = await sign(ENV.RESEND_WEBHOOK_SECRET, id, String(ts), body);
    return webhookHandler(new Request(`${F}/rv-resend-webhook`, {
      method: 'POST',
      headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' },
      body: tamper ? body.replace('delivered', 'complained') : body,
    }), deps);
  };
  const delivered = { type: 'email.delivered', created_at: now(), data: { email_id: msgId, tags: { rv: 'job' } } };

  assert.equal((await hook(delivered, { tamper: true })).status, 401, 'veränderter Body');
  assert.equal((await hook(delivered, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401, 'zu alt (Replay)');
  const unsigned = await webhookHandler(new Request(`${F}/rv-resend-webhook`, { method: 'POST', body: JSON.stringify(delivered) }), deps);
  assert.equal(unsigned.status, 401);
  assert.equal(await c.count('select count(*) n from review.provider_events'), 0);

  assert.equal((await (await hook(delivered, { id: 'evt_a' })).json()).result, 'applied');
  assert.equal((await (await hook(delivered, { id: 'evt_a' })).json()).result, 'duplicate');

  const bounce = { type: 'email.bounced', created_at: now(), data: { email_id: msgId, bounce: { type: 'Permanent' } } };
  assert.equal((await (await hook(bounce)).json()).result, 'applied');
  assert.equal((await c.one('select reason from review.suppressions')).reason, 'hard_bounce');

  const unknownJob = await hook({ type: 'email.delivered', created_at: now(), data: { email_id: 'msg_spaeter', tags: [{ name: 'rv', value: 'job' }] } });
  assert.equal(unknownJob.status, 409, 'Job-Mail noch unbekannt: Resend soll später erneut zustellen');
  const report = await hook({ type: 'email.delivered', created_at: now(), data: { email_id: 'msg_report', tags: { rv: 'report' } } });
  assert.equal(report.status, 200);
  const opened = await hook({ type: 'email.opened', created_at: now(), data: { email_id: msgId } });
  assert.equal((await opened.json()).result, 'ignored');

  assert.equal(mapEvent({ type: 'email.bounced', data: { bounce: { type: 'Temporary' } } }), 'bounced_soft');
});

withDb('Wochenbericht über rv-jobs: genau eine Mail an die Inhaberin, Testmodus-Hinweis', async (c) => {
  const s = await c.seed({ testMode: true, testRecipients: ['x@example.test'] });
  const resend = fakeResend();
  const monday = new Date('2026-11-16T07:00:00Z');
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch, now: () => monday });
  const r1 = await work(deps, 'weekly-report');
  assert.equal(r1.sent, 1);
  const m = resend.sent.find((x) => x.to[0] === 'inhaberin@example.test');
  assert.ok(m);
  assert.match(m.subject, /09\.11\.2026 bis 15\.11\.2026/);
  assert.match(m.text, /Testmodus ist aktiv/);
  assert.match(m.text, /Abgleich mit Google ist noch nicht aktiv/);
  assert.equal(m.key, `rv-report-${s.tenantId}-2026-11-09`);
  const r2 = await work(deps, 'weekly-report');
  assert.equal(r2.claimed, 0);
  assert.equal(resend.sent.length, 1);
});

withDb('Google-Abgleich: nicht konfiguriert meldet das ehrlich; mit Fixtures idempotent, Fehler sichtbar', async (c) => {
  const s = await c.seed();
  const { deps: plain } = makeDeps(c.svc);
  assert.equal((await work(plain, 'google-sync')).status, 'not_configured');

  await c.svc.query(`select public.rv_set_google_location($1, 'accounts/1/locations/2')`, [s.locationId]);
  let fail = false;
  const gfetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'ya29.test' }));
    const u = new URL(url);
    assert.equal(u.pathname, '/v4/accounts/1/locations/2/reviews');
    if (fail) return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 });
    if (!u.searchParams.get('pageToken')) {
      return new Response(JSON.stringify({
        reviews: [
          { reviewId: 'a', starRating: 'FIVE', comment: 'Super', createTime: '2026-11-10T10:00:00Z', updateTime: '2026-11-10T10:00:00Z', reviewer: { displayName: 'Max' } },
          { reviewId: 'b', starRating: 'FOUR', createTime: '2026-11-09T10:00:00Z', updateTime: '2026-11-09T10:00:00Z' },
        ],
        nextPageToken: 'p2',
      }));
    }
    return new Response(JSON.stringify({ reviews: [{ reviewId: 'c', starRating: 'THREE', createTime: '2026-11-01T10:00:00Z', updateTime: '2026-11-01T10:00:00Z', reviewReply: { comment: 'Danke' } }] }));
  };
  const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt' };
  const { deps } = makeDeps(c.svc, { fetch: gfetch, env });
  const r1 = await work(deps, 'google-sync');
  assert.equal(r1.results[0].inserted, 3, JSON.stringify(r1));
  const r2 = await work(deps, 'google-sync');
  assert.equal(r2.results[0].inserted, 0);
  assert.equal(r2.results[0].updated, 0);
  const stored = (await c.root.query('select * from review.google_reviews order by review_id')).rows;
  assert.deepEqual(stored.map((x) => [x.review_id, x.star_rating, x.has_comment, x.has_reply]), [['a', 5, true, false], ['b', 4, false, false], ['c', 3, false, true]]);

  fail = true;
  const r3 = await work(deps, 'google-sync');
  assert.match(r3.results[0].error, /403/);
  const ops = await work(makeDeps(c.svc).deps, 'ops');
  assert.ok(ops.alerts.some((a) => a.code === 'google_sync_errors'));
});

withDb('Betriebswarnung: höchstens eine Mail pro Tag und Warnkombination', async (c) => {
  const s = await c.seed();
  const r = await c.ingest(s.apiKey);
  await c.root.query(`update review.send_jobs set status = 'unknown' where id = $1`, [r.job_id]);
  const resend = fakeResend();
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  assert.equal((await work(deps, 'ops')).alert, 'sent');
  assert.equal((await work(deps, 'ops')).alert, 'already_sent_today');
  assert.equal(resend.sent.length, 1, 'aber nur eine echte Mail');
  assert.equal(resend.sent[0].to[0], 'ops@example.test');
});

test('Vorlagen: HTML-Escaping, keine Header-Injection, ohne Vorname neutrale Anrede', () => {
  const m = renderRequest('initial', {
    studio: 'Studio <b>X</b>\r\nBcc: evil@example.test',
    firstName: '<script>alert(1)</script>',
    clickUrl: 'https://link.example.test/r/?t=abc',
    unsubUrl: 'https://link.example.test/abmelden/?t=abc',
  });
  assert.ok(!m.html.includes('<script>'));
  assert.ok(!m.html.includes('<b>X</b>'));
  assert.ok(!/[\r\n]/.test(m.subject));
  const n = renderRequest('reminder', { studio: 'S', firstName: null, clickUrl: 'https://a/', unsubUrl: 'https://b/' });
  assert.match(n.text, /^Hallo,/);
  assert.match(n.text, /letzte Nachricht/);
});

test('Google-Normalisierung speichert keine Namen und behandelt fehlende Sterne', () => {
  const r = normalizeReview({ name: 'accounts/1/locations/2/reviews/xyz', starRating: 'STAR_RATING_UNSPECIFIED', createTime: '2026-01-01T00:00:00Z', reviewer: { displayName: 'Max' } });
  assert.deepEqual(r, { review_id: 'xyz', star_rating: null, has_comment: false, has_reply: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  assert.equal(normalizeReview({}), null);
});
