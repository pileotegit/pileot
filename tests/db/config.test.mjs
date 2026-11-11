// Kundenschablone: Konfiguration, Validierung, Livegang, Schlüssel, Rechte.
import assert from 'node:assert/strict';
import { withDb } from './helpers.mjs';

const BASE = {
  name: 'Kosmetik Lena',
  location_name: 'Kosmetikstudio Lena',
  google_review_url: 'https://g.page/r/LENA123/review',
  sender_name: 'Kosmetikstudio Lena',
  sender_email: 'Bewertung@Mail.Pileot.de',
  reply_to_email: 'lena@example.test',
  report_recipient_email: 'lena@example.test',
};

const save = (c, id, cfg) => c.svc.query('select public.rv_admin_save_tenant($1, $2) as r', [id, JSON.stringify(cfg)]).then((r) => r.rows[0].r);
const saveErr = (c, id, cfg) => save(c, id, cfg).then(() => 'ok', (e) => e.message);
const get = (c, id) => c.svc.query('select public.rv_admin_get_tenant($1) as r', [id]).then((r) => r.rows[0].r);

withDb('Schablone: neue Kundin mit Pflichtfeldern, sichere Standards, Standardtexte identisch mit Spaltenstandards', async (c) => {
  const r = await save(c, null, BASE);
  assert.equal(r.created, true);
  const t = await get(c, r.tenant_id);
  assert.equal(t.status, 'paused');
  assert.equal(t.test_mode, true);
  assert.equal(t.config.sender_email, 'bewertung@mail.pileot.de', 'Adressen werden normalisiert');
  const d = (await c.svc.query('select public.rv_admin_defaults() as d')).rows[0].d;
  for (const [k, v] of Object.entries(d)) assert.deepEqual(t.config[k], v, `Standard ${k}`);
  assert.equal(await c.count('select count(*) n from review.message_templates where tenant_id = $1', [r.tenant_id]), 2);
  const l = await c.svc.query('select * from public.rv_admin_list_tenants() r').then((x) => x.rows[0].r);
  assert.equal(l.length, 1);
  assert.equal(l[0].name, 'Kosmetik Lena');
});

withDb('Schablone: Validierung lehnt falsche Felder, Platzhalter, Formate und Werte ab', async (c) => {
  assert.match(await saveErr(c, null, { name: 'x' }), /Pflichtfeld location_name fehlt/);
  const { tenant_id: id } = await save(c, null, BASE);
  const cases = [
    [{ hacker: 1 }, /unbekanntes Feld hacker/],
    [{ initial_subject: 'Hallo {{name}}' }, /message_templates_subject_check/],
    [{ initial_subject: 'Hallo {{vorname}}' }, /message_templates_subject_check/, 'Vorname nur in der Anrede'],
    [{ initial_subject: 'Zeile 1\nZeile 2' }, /message_templates_subject_check/],
    [{ greeting_anonymous: 'Hallo {{vorname}}' }, /greeting_anonymous_check/],
    [{ initial_body: '' }, /message_templates_body_check/],
    [{ accent_color: 'red' }, /accent_color_check/],
    [{ google_review_url: 'https://evil.example/review' }, /google_review_url_check/],
    [{ google_review_url: 'https://www.google.com/url?q=https://evil' }, /google_review_url_check/],
    [{ sender_email: 'kein-at' }, /sender_email_check/],
    [{ test_recipients: ['ok@example.test', 'kaputt'] }, /ungültige E-Mail/],
    [{ send_window_start: '18:00', send_window_end: '09:00' }, /tenant_settings_check/],
    [{ send_window_start: '25:99' }, /invalid_config/],
    [{ send_weekdays: [0, 8] }, /send_weekdays/],
    [{ max_sends_per_day: '20' }, /ganze Zahl/],
    [{ max_sends_per_day: 9999 }, /max_sends_per_day_check/],
    [{ report_enabled: 'ja' }, /true oder false/],
    [{ timezone: 'Mond/Krater' }, /invalid_config/],
    [{ imprint_text: 'x'.repeat(601) }, /imprint_text_check/],
  ];
  for (const [cfg, re, why] of cases) assert.match(await saveErr(c, id, cfg), re, why ?? JSON.stringify(cfg));
  // Nichts davon wurde gespeichert
  const t = await get(c, id);
  assert.equal(t.config.accent_color, '#1f2937');
  assert.equal(t.config.google_review_url, BASE.google_review_url);
  assert.match(await saveErr(c, '00000000-0000-4000-8000-000000000000', { name: 'x' }), /nicht gefunden/);
});

withDb('Schablone: Änderungen nur an übergebenen Feldern, Normalisierung von Text, Tagen und Testadressen', async (c) => {
  const { tenant_id: id } = await save(c, null, BASE);
  await save(c, id, {
    initial_body: '  Absatz eins.\r\n\r\nAbsatz {{ studio }} zwei.  ',
    signature: 'Liebe Grüße\r\nLena',
    send_weekdays: [5, 1, 1, 3],
    test_recipients: [' Malik@Example.test ', '', 'malik@example.test'],
    accent_color: '#AA3366',
    report_enabled: false,
    max_sends_per_day: 5,
  });
  const t = (await get(c, id)).config;
  assert.equal(t.initial_body, 'Absatz eins.\n\nAbsatz {{ studio }} zwei.');
  assert.equal(t.signature, 'Liebe Grüße\nLena');
  assert.deepEqual(t.send_weekdays, [1, 3, 5]);
  assert.deepEqual(t.test_recipients, ['malik@example.test']);
  assert.equal(t.accent_color, '#aa3366');
  assert.equal(t.report_enabled, false);
  assert.equal(t.max_sends_per_day, 5);
  assert.equal(t.reminder_subject, 'Kurze Erinnerung: Ihre Meinung zu {{studio}}', 'unverändert');
  assert.equal(t.name, 'Kosmetik Lena', 'unverändert');
  assert.deepEqual((await c.svc.query('select public.rv_get_mail_config($1) as r', [id])).rows[0].r, t);
});

withDb('Livegang: nur mit bestätigtem Namen, Impressum und einer echten Testmail', async (c) => {
  const s = await c.seed({ testMode: true, testRecipients: ['test@example.test'] });
  await c.root.query(`update review.tenant_settings set imprint_text = '' where tenant_id = $1`, [s.tenantId]);
  const live = (name) => c.svc.query('select public.rv_admin_go_live($1, $2) as r', [s.tenantId, name]).then((r) => r.rows[0].r);

  const r1 = await live('Falscher Name');
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.missing, ['confirm_name_mismatch', 'imprint_missing', 'no_test_send']);
  assert.equal((await get(c, s.tenantId)).test_mode, true, 'nichts geändert');

  await save(c, s.tenantId, { imprint_text: 'Lena Muster, Musterstr. 1, 72070 Tübingen' });
  await c.sentCampaign(s, { email: 'test@example.test' });
  const r2 = await live('  test studio ');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const t = await get(c, s.tenantId);
  assert.equal(t.test_mode, false);
  assert.equal(t.status, 'active');
});

withDb('Schlüssel widerrufen: danach lehnt rv_ingest_completion ab, fremder Mandant kann nicht widerrufen', async (c) => {
  const a = await c.seed();
  const b = await c.seed({ name: 'Anderes Studio' });
  const integ = (await get(c, a.tenantId)).integrations[0];
  const revoke = (tid) => c.svc.query('select public.rv_admin_revoke_integration($1, $2) as r', [tid, integ.id]).then((r) => r.rows[0].r);
  assert.equal(await revoke(b.tenantId), false);
  assert.equal((await c.ingest(a.apiKey)).result, 'created');
  assert.equal(await revoke(a.tenantId), true);
  assert.equal(await revoke(a.tenantId), false, 'zweimal ist kein Fehler, aber auch keine Änderung');
  assert.equal((await c.ingest(a.apiKey)).reason, 'integration_invalid');
  assert.ok((await get(c, a.tenantId)).integrations[0].revoked_at);
});

withDb('Wochenbericht abgeschaltet: keine Reservierung für diese Kundin', async (c) => {
  const s = await c.seed();
  await save(c, s.tenantId, { report_enabled: false });
  const rows = (await c.svc.query(`select * from public.rv_claim_weekly_reports('2026-11-16T08:00:00Z')`)).rows;
  assert.equal(rows.filter((x) => x.tenant_id === s.tenantId).length, 0);
  await save(c, s.tenantId, { report_enabled: true });
  const rows2 = (await c.svc.query(`select * from public.rv_claim_weekly_reports('2026-11-16T08:00:00Z')`)).rows;
  assert.equal(rows2.filter((x) => x.tenant_id === s.tenantId).length, 1);
});

withDb('Rechte: Admin-Funktionen nur für service_role, neue Tabelle mit RLS und ohne Zugriff', async (c) => {
  for (const role of ['anon', 'authenticated']) {
    const cl = await c.asRole(role);
    for (const sql of ['select public.rv_admin_list_tenants()', 'select public.rv_admin_defaults()',
      `select public.rv_admin_save_tenant(null, '{}')`, `select public.rv_get_mail_config(gen_random_uuid())`]) {
      assert.equal(await cl.query(sql).then(() => 'ok', (e) => e.code), '42501', `${role}: ${sql}`);
    }
  }
  const svc = await c.asRole('service_role');
  assert.equal(await svc.query('select * from review.message_templates').then(() => 'ok', (e) => e.code), '42501');
  assert.equal(await svc.query(`select review.valid_text('x', true)`).then(() => 'ok', (e) => e.code), '42501');
  const rls = await c.one(`select relrowsecurity r from pg_class where oid = 'review.message_templates'::regclass`);
  assert.equal(rls.r, true);
});
