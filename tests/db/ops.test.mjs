import assert from 'node:assert/strict';
import { withDb } from './helpers.mjs';

withDb('Einrichtung: neuer Mandant ist pausiert und im Testmodus, Versand nur nach bewusster Freigabe', async (c) => {
  const r = await c.svc.query(`select public.rv_setup_tenant('Studio Test', 'Studio Test', 'https://g.page/r/ABC/review',
      'Studio Test', 'bewertung@mail.example.test', 'Inhaberin@Example.test', 'inhaberin@example.test',
      'Europe/Berlin', array['Test1@Example.test']) as r`);
  const { tenant_id, location_id, status, test_mode } = r.rows[0].r;
  assert.equal(status, 'paused');
  assert.equal(test_mode, true);
  const s = await c.one('select test_recipients, reply_to_email from review.tenant_settings where tenant_id = $1', [tenant_id]);
  assert.deepEqual(s.test_recipients, ['test1@example.test']);
  assert.equal(s.reply_to_email, 'inhaberin@example.test');

  const key = (await c.svc.query(`select public.rv_create_integration($1, $2, 'formular') as k`, [tenant_id, location_id])).rows[0].k;
  assert.equal((await c.ingest(key)).reason, 'tenant_paused');
  await c.svc.query(`select public.rv_set_tenant_status($1, 'active')`, [tenant_id]);
  const ok = await c.ingest(key, { email: 'fremd@example.test' });
  await c.makeDue(ok.job_id);
  // Fenster 09-18 Mo-Fr: für den Test öffnen
  await c.root.query(`update review.tenant_settings set send_window_start = '00:00', send_window_end = '24:00', send_weekdays = '{1,2,3,4,5,6,7}' where tenant_id = $1`, [tenant_id]);
  assert.equal((await c.claim()).length, 0, 'Testmodus: fremde Adresse bekommt nichts');
  assert.equal((await c.one('select status from review.send_jobs where id = $1', [ok.job_id])).status, 'dry_run');

  await c.svc.query(`select public.rv_set_test_mode($1, false)`, [tenant_id]);
  assert.deepEqual((await c.one('select test_recipients from review.tenant_settings where tenant_id = $1', [tenant_id])).test_recipients, ['test1@example.test']);
});

withDb('Google-Abgleich ist idempotent und speichert keine Namen oder Texte', async (c) => {
  const s = await c.seed();
  await c.svc.query(`select public.rv_set_google_location($1, 'accounts/123/locations/456')`, [s.locationId]);
  const bad = await c.svc.query(`select public.rv_set_google_location($1, 'https://evil')`, [s.locationId]).then(() => 'ok', (e) => e.code);
  assert.equal(bad, '23514');

  const list = (await c.svc.query('select * from public.rv_list_google_locations()')).rows;
  assert.equal(list.length, 1);

  const reviews = [
    { review_id: 'r1', star_rating: 5, has_comment: true, has_reply: false, created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z' },
    { review_id: 'r2', star_rating: 4, has_comment: false, has_reply: false, created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z' },
  ];
  const up = (arr) => c.svc.query('select public.rv_upsert_google_reviews($1, $2) as r', [s.locationId, JSON.stringify(arr)]).then((r) => r.rows[0].r);
  assert.deepEqual(await up(reviews), { inserted: 2, updated: 0 });
  assert.deepEqual(await up(reviews), { inserted: 0, updated: 0 }, 'wiederholter Abgleich ändert nichts');
  reviews[1] = { ...reviews[1], has_reply: true, updated_at: '2026-11-11T08:00:00Z' };
  assert.deepEqual(await up(reviews), { inserted: 0, updated: 1 });

  const cols = (await c.root.query(`select column_name from information_schema.columns where table_schema = 'review' and table_name = 'google_reviews'`)).rows.map((r) => r.column_name);
  for (const forbidden of ['reviewer', 'reviewer_name', 'comment', 'text', 'profile_photo_url']) {
    assert.ok(!cols.includes(forbidden), forbidden);
  }
  assert.ok((await c.one('select google_last_sync_at from review.locations where id = $1', [s.locationId])).google_last_sync_at);
});

withDb('Wochenbericht: Wochengrenzen in Ortszeit, korrekt über die Sommerzeitumstellung', async (c) => {
  const s = await c.seed();
  // Montag nach der Umstellung am 29.03.2026: Woche 23.03. bis 29.03.
  const rows = (await c.svc.query(`select * from public.rv_claim_weekly_reports('2026-03-30T08:00:00Z')`)).rows;
  const mine = rows.find((r) => r.tenant_id === s.tenantId);
  assert.ok(mine);
  assert.equal(mine.report.week_start, '2026-03-23');
  assert.equal(new Date(mine.report.from_utc).toISOString(), '2026-03-22T23:00:00.000Z');
  assert.equal(new Date(mine.report.to_utc).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(mine.idempotency_key, `rv-report-${s.tenantId}-2026-03-23`);

  // Herbst: Woche 19.10. bis 25.10.2026 (Umstellung am 25.10.) ist 169 Stunden lang
  const p = (await c.svc.query(`select public.rv_weekly_report_preview($1, '2026-10-19') as r`, [s.tenantId])).rows[0].r;
  const hours = (new Date(p.to_utc) - new Date(p.from_utc)) / 3600e3;
  assert.equal(hours, 169);
});

withDb('Wochenbericht: genau einmal pro Woche, erneute Ausgabe nur nach abgelaufener Reservierung', async (c) => {
  const s = await c.seed();
  const now = '2026-11-16T07:00:00Z';
  const claim = (t) => c.svc.query('select * from public.rv_claim_weekly_reports($1)', [t]).then((r) => r.rows.filter((x) => x.tenant_id === s.tenantId));
  assert.equal((await claim(now)).length, 1);
  assert.equal((await claim(now)).length, 0, 'zweiter Lauf in derselben Woche: nichts');
  assert.equal((await claim('2026-11-16T07:40:00Z')).length, 1, 'nach 30 Minuten ohne Bestätigung erneut');
  await c.svc.query(`select public.rv_complete_weekly_report($1, '2026-11-09', 'msg_rep')`, [s.tenantId]);
  assert.equal((await claim('2026-11-16T09:00:00Z')).length, 0, 'gesendet: nie wieder');
  assert.equal((await claim('2026-11-23T07:00:00Z')).length, 1, 'nächste Woche');
});

withDb('Wochenbericht zählt die Ereignisse der Woche', async (c) => {
  const s = await c.seed();
  const a = await c.sentCampaign(s);
  const b = await c.sentCampaign(s);
  await c.svc.query(`select public.rv_apply_provider_event('resend', 'e1', 'delivered', now(), $1)`, [a.msgId]);
  await c.svc.query(`select public.rv_apply_provider_event('resend', 'e2', 'bounced_hard', now(), $1)`, [b.msgId]);
  await c.svc.query(`select public.rv_register_click($1, 'raw')`, [a.clickToken]);
  await c.svc.query(`select public.rv_register_click($1, 'qualified')`, [a.clickToken]);
  const week = (await c.one(`select (date_trunc('week', now() at time zone 'Europe/Berlin'))::date::text as w`)).w;
  const p = (await c.svc.query('select public.rv_weekly_report_preview($1, $2) as r', [s.tenantId, week])).rows[0].r;
  assert.equal(p.completions, 2);
  assert.equal(p.initial_sent, 2);
  assert.equal(p.delivered, 1);
  assert.equal(p.bounced, 1);
  assert.equal(p.qualified_clicks, 1);
  assert.equal(p.google.enabled, false);
});

withDb('Betrieb: Warnungen für unklare und überfällige Jobs', async (c) => {
  const s = await c.seed();
  const h0 = (await c.svc.query('select public.rv_ops_health() as r')).rows[0].r;
  assert.deepEqual(h0.alerts, []);
  const r = await c.ingest(s.apiKey);
  await c.root.query(`update review.send_jobs set due_at = now() - interval '3 hours' where id = $1`, [r.job_id]);
  const h1 = (await c.svc.query('select public.rv_ops_health() as r')).rows[0].r;
  assert.deepEqual(h1.alerts.map((a) => a.code), ['overdue_jobs']);
  await c.root.query(`update review.send_jobs set status = 'unknown' where id = $1`, [r.job_id]);
  const h2 = (await c.svc.query('select public.rv_ops_health() as r')).rows[0].r;
  assert.deepEqual(h2.alerts.map((a) => a.code), ['unknown_jobs']);
});

withDb('Aufbewahrung: alte, beendete Kontakte werden gelöscht, Sperren bleiben', async (c) => {
  const s = await c.seed();
  const a = await c.sentCampaign(s);
  await c.svc.query('select public.rv_unsubscribe($1)', [a.unsubToken]);
  const active = await c.ingest(s.apiKey);
  await c.root.query(`update review.contacts set created_at = now() - interval '400 days'`);
  await c.root.query(`update review.campaigns set created_at = now() - interval '400 days'`);
  const res = (await c.svc.query('select public.rv_purge_expired() as r')).rows[0].r;
  assert.equal(res.contacts_deleted, 1, 'nur der beendete Kontakt');
  assert.equal(await c.count('select count(*) n from review.suppressions'), 1);
  assert.equal(await c.count('select count(*) n from review.campaigns where id = $1', [active.campaign_id]), 1);
});

withDb('Rechte: jede rv_-Funktion ist nur für service_role ausführbar, jede review-Funktion für niemanden', async (c) => {
  const rows = (await c.root.query(`
    select p.proname, n.nspname,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth,
           has_function_privilege('service_role', p.oid, 'execute') as svc,
           p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname like 'rv\\_%') or n.nspname = 'review'`)).rows;
  assert.ok(rows.length > 20);
  for (const r of rows) {
    assert.equal(r.anon, false, `anon ${r.proname}`);
    assert.equal(r.auth, false, `authenticated ${r.proname}`);
    if (r.nspname === 'public') {
      assert.equal(r.svc, true, `service_role ${r.proname}`);
      assert.equal(r.prosecdef, true, `security definer ${r.proname}`);
    }
    assert.ok((r.proconfig ?? []).some((x) => x === 'search_path=""' || x === 'search_path='), `search_path ${r.proname}: ${r.proconfig}`);
  }
});

withDb('Betrieb: nachts fällig gewordene Jobs lösen keinen Fehlalarm aus', async (c) => {
  const s = await c.seed();
  await c.root.query(`update review.tenant_settings set send_window_start = '09:00', send_window_end = '18:00', send_weekdays = '{1,2,3,4,5}' where tenant_id = $1`, [s.tenantId]);
  const r = await c.ingest(s.apiKey);
  await c.root.query(`update review.send_jobs set due_at = '2026-11-10T18:30:00Z' where id = $1`, [r.job_id]);
  const night = (await c.svc.query(`select public.rv_ops_health('2026-11-11T03:07:00Z') as r`)).rows[0].r;
  assert.equal(night.overdue_jobs, 0);
  const noon = (await c.svc.query(`select public.rv_ops_health('2026-11-11T12:07:00Z') as r`)).rows[0].r;
  assert.equal(noon.overdue_jobs, 1, 'mittags im Fenster: echter Rückstand');
});
