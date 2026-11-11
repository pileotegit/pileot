// rv-admin (Kundenformular) und Versand mit eigenen Texten, gegen echtes Postgres.
import assert from 'node:assert/strict';
import { withDb } from '../db/helpers.mjs';
import { ENV, fakeResend, jsonReq, makeDeps } from './fakes.mjs';
import { configError, handler as adminHandler } from '../../supabase/functions/rv-admin/handler.ts';
import { handler as ingestHandler } from '../../supabase/functions/rv-ingest/handler.ts';
import { handler as jobsHandler } from '../../supabase/functions/rv-jobs/handler.ts';

const F = ENV.FUNCTIONS_BASE_URL;
const ORIGIN = 'https://link.example.test';
const admin = (deps, body, secret = ENV.ADMIN_SECRET) =>
  adminHandler(jsonReq(`${F}/rv-admin`, body, secret ? { 'x-rv-admin-secret': secret, origin: ORIGIN } : { origin: ORIGIN }), deps);
const call = async (deps, body) => {
  const r = await admin(deps, body);
  return { status: r.status, body: await r.json() };
};

const BASE = {
  name: 'Kosmetik Lena',
  location_name: 'Kosmetikstudio Lena',
  google_review_url: 'https://g.page/r/LENA123/review',
  sender_name: 'Kosmetikstudio Lena',
  sender_email: 'bewertung@mail.example.test',
  reply_to_email: 'lena@example.test',
  report_recipient_email: 'lena@example.test',
};

withDb('rv-admin: ohne richtiges Passwort nichts, CORS nur für eigene Seite, unbekannte Aktion 400', async (c) => {
  const { deps } = makeDeps(c.svc);
  assert.equal((await admin(deps, { action: 'list' }, null)).status, 401);
  assert.equal((await admin(deps, { action: 'list' }, 'a'.repeat(39))).status, 401);
  const short = makeDeps(c.svc, { env: { ADMIN_SECRET: 'kurz' } }).deps;
  assert.equal((await admin(short, { action: 'list' }, 'kurz')).status, 401, 'zu kurzes Secret ist gesperrt');
  const unset = makeDeps(c.svc, { env: { ADMIN_SECRET: undefined } }).deps;
  assert.equal((await admin(unset, { action: 'list' }, '')).status, 401);

  const pre = await adminHandler(new Request(`${F}/rv-admin`, { method: 'OPTIONS', headers: { origin: ORIGIN } }), deps);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /x-rv-admin-secret/);
  const foreign = await adminHandler(new Request(`${F}/rv-admin`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), deps);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);

  assert.equal((await call(deps, { action: 'gibtsnicht' })).status, 400);
  assert.equal((await call(deps, { action: 'get', tenant_id: 'kein-uuid' })).status, 400);
  assert.deepEqual((await call(deps, { action: 'list' })).body, { tenants: [] });
});

withDb('rv-admin: anlegen, Fehler verständlich, Vorschau mit eigenen Texten, Schlüssel nur einmal', async (c) => {
  const { deps } = makeDeps(c.svc);
  const d = (await call(deps, { action: 'defaults' })).body;
  assert.equal(d.initial_button, 'Bewertung bei Google schreiben');

  const bad = await call(deps, { action: 'save', tenant_id: null, config: { ...BASE, accent_color: 'rot' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.message, 'Ungültiger Wert: Buttonfarbe');
  assert.equal((await call(deps, { action: 'list' })).body.tenants.length, 0, 'fehlerhaftes Anlegen hinterlässt nichts');

  const created = await call(deps, { action: 'save', tenant_id: null, config: BASE });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.tenant_id;

  const pv = await call(deps, { action: 'preview', config: { ...BASE, greeting_named: 'Liebe {{vorname}},', initial_subject: 'Danke von {{studio}}' } });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.initial.subject, 'Danke von Kosmetikstudio Lena');
  assert.match(pv.body.initial.text, /^Liebe Anna,/);
  assert.equal(pv.body.from, '"Kosmetikstudio Lena" <bewertung@mail.example.test>');

  const k = await call(deps, { action: 'create-key', tenant_id: id, source: 'eintragsformular' });
  assert.match(k.body.key, /^rvk_[0-9a-f]{64}$/);
  const t = (await call(deps, { action: 'get', tenant_id: id })).body;
  assert.equal(t.integrations.length, 1);
  assert.ok(!JSON.stringify(t).includes(k.body.key), 'Klartextschlüssel wird nie wieder ausgegeben');

  const act = await call(deps, { action: 'set-status', tenant_id: id, status: 'active' });
  assert.equal(act.status, 200, 'im Testmodus darf aktiviert werden');
  const live = await call(deps, { action: 'go-live', tenant_id: id, confirm_name: 'Kosmetik Lena' });
  assert.equal(live.body.ok, false);
  assert.deepEqual(live.body.missing, ['imprint_missing', 'no_test_send']);
});

withDb('Versand mit eigenen Texten: Testmail an Testadresse, danach Livegang, aktiv ohne Testmodus nur über go-live', async (c) => {
  const resend = fakeResend();
  const { deps } = makeDeps(c.svc, { fetch: resend.fetch });
  const config = {
    ...BASE,
    test_recipients: ['malik@example.test'],
    send_window_start: '00:00', send_window_end: '23:59', send_weekdays: [1, 2, 3, 4, 5, 6, 7],
    initial_delay_minutes: 0,
    greeting_named: 'Liebe {{vorname}},',
    initial_subject: 'Danke für Ihren Besuch bei {{studio}}',
    initial_body: 'schön, dass Sie da waren.\n\nWir freuen uns über Ihre ehrliche Meinung.',
    initial_button: 'Jetzt bewerten',
    initial_closing: 'Es dauert nur eine Minute.',
    signature: 'Herzlich\nLena',
    imprint_text: 'Lena Muster, Musterstr. 1, 72070 Tübingen',
    accent_color: '#aa3366',
  };
  const id = (await call(deps, { action: 'save', tenant_id: null, config })).body.tenant_id;
  const key = (await call(deps, { action: 'create-key', tenant_id: id })).body.key;
  await call(deps, { action: 'set-status', tenant_id: id, status: 'active' });

  const ing = await ingestHandler(jsonReq(`${F}/rv-ingest`, {
    event_id: 'e1', contact_ref: 'k1', email: 'Malik@example.test', first_name: 'Malik', completed_at: new Date().toISOString(),
    consent: { basis: 'explicit_opt_in', source: 'Test', documented_at: new Date().toISOString() },
  }, { authorization: `Bearer ${key}`, origin: ORIGIN }), deps);
  assert.equal(ing.status, 201);
  assert.equal(ing.headers.get('access-control-allow-origin'), ORIGIN, 'Eintragsformular darf rv-ingest aufrufen');
  await c.root.query(`update review.send_jobs set due_at = now() - interval '1 minute'`);

  const run = await jobsHandler(jsonReq(`${F}/rv-jobs`, { action: 'send' }, { 'x-rv-worker-secret': ENV.WORKER_SECRET }), deps).then((r) => r.json());
  assert.equal(run.sent, 1, JSON.stringify(run));
  const m = resend.sent[0];
  assert.equal(m.subject, 'Danke für Ihren Besuch bei Kosmetikstudio Lena');
  assert.match(m.text, /^Liebe Malik,\n\nschön, dass Sie da waren\.\n\nWir freuen uns/);
  assert.match(m.text, /Jetzt bewerten:\nhttps:\/\/link\.example\.test\/r\/\?t=/);
  assert.match(m.text, /Es dauert nur eine Minute\.\n\nHerzlich\nLena/);
  assert.match(m.text, /72070 Tübingen/);
  assert.ok(m.html.includes('background:#aa3366'));
  assert.ok(m.html.includes('Herzlich<br>Lena'));

  // Aktiv und ohne Testmodus nur über go-live
  assert.equal((await call(deps, { action: 'set-status', tenant_id: id, status: 'paused' })).status, 200);
  const wrong = await call(deps, { action: 'go-live', tenant_id: id, confirm_name: 'Lena' });
  assert.deepEqual(wrong.body.missing, ['confirm_name_mismatch']);
  const ok = await call(deps, { action: 'go-live', tenant_id: id, confirm_name: 'kosmetik lena' });
  assert.equal(ok.body.ok, true);
  const t = (await call(deps, { action: 'get', tenant_id: id })).body;
  assert.equal(t.status, 'active');
  assert.equal(t.test_mode, false);
  assert.equal(t.sent_total, 1);
  await call(deps, { action: 'test-mode-on', tenant_id: id });
  assert.equal((await call(deps, { action: 'get', tenant_id: id })).body.test_mode, true);
});

withDb('configError übersetzt PostgREST- und Postgres-Fehler', async () => {
  const pgrest = new Error('rpc rv_admin_save_tenant 400: {"code":"P0001","message":"invalid_config: new row for relation \\"tenant_settings\\" violates check constraint \\"tenant_settings_imprint_text_check\\""}');
  assert.equal(configError(pgrest), 'Ungültiger Wert: Impressum');
  assert.equal(configError(new Error('invalid_config: Pflichtfeld name fehlt')), 'Pflichtfeld name fehlt');
  assert.equal(configError(new Error('irgendwas anderes')), null);
});
