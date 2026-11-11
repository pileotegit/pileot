import assert from 'node:assert/strict';
import { withDb, ingest } from './helpers.mjs';

// Alle Daten sind synthetisch (example.test). Die Tests laufen gegen ein echtes Postgres 16.

// ---------------------------------------------------------------------------
// Abschluss aufnehmen (Workflow A)
// ---------------------------------------------------------------------------

withDb('doppeltes Abschlussereignis (10 parallele Aufrufe) erzeugt genau eine Kampagne und einen Erstversand', async (c) => {
  const s = await c.seed();
  const clients = await Promise.all(Array.from({ length: 10 }, () => c.newSvc()));
  const ev = { eventId: 'evt-dup', contactRef: 'c-dup', email: 'dup@example.test' };
  const results = await Promise.all(clients.map((x) => ingest(x, s.apiKey, ev)));
  assert.equal(results.filter((r) => r.result === 'created').length, 1, JSON.stringify(results));
  assert.ok(results.every((r) => ['created', 'duplicate'].includes(r.result)), JSON.stringify(results));
  assert.equal(await c.count('select count(*) n from review.campaigns where tenant_id = $1', [s.tenantId]), 1);
  assert.equal(await c.count('select count(*) n from review.send_jobs where tenant_id = $1', [s.tenantId]), 1);
});

withDb('gleiche Ereignis-ID mit verschiedenen Kontaktkennungen (parallel): genau eine Kampagne, keine Exception', async (c) => {
  const s = await c.seed();
  const clients = await Promise.all(Array.from({ length: 6 }, () => c.newSvc()));
  const results = await Promise.all(
    clients.map((x, i) => ingest(x, s.apiKey, { eventId: 'evt-shared', contactRef: `ref-${i}`, email: `person${i}@example.test` })),
  );
  assert.equal(results.filter((r) => r.result === 'created').length, 1, JSON.stringify(results));
  assert.equal(await c.count('select count(*) n from review.campaigns'), 1);
  assert.equal(await c.count('select count(*) n from review.send_jobs'), 1);
});

withDb('Ablehnungen: ungültiger Key, fehlende Versandgrundlage, Sperre, pausierter Mandant, alt, Zukunft, ungültige Adresse', async (c) => {
  const s = await c.seed();
  assert.equal((await c.ingest('rvk_' + 'x'.repeat(40))).reason, 'integration_invalid');
  assert.equal((await c.ingest(s.apiKey, { consent: null })).reason, 'no_consent');
  assert.equal(await c.count('select count(*) n from review.contacts'), 0, 'ohne Grundlage wird nichts gespeichert');

  await c.root.query(`insert into review.suppressions (tenant_id, email_hash, reason) values ($1, review.email_hash($2), 'manual')`, [s.tenantId, 'gesperrt@example.test']);
  assert.equal((await c.ingest(s.apiKey, { email: ' Gesperrt@Example.test ' })).reason, 'suppressed');

  const old = new Date(Date.now() - 8 * 86400e3).toISOString();
  const fut = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await c.ingest(s.apiKey, { completedAt: old })).reason, 'stale_event');
  assert.equal((await c.ingest(s.apiKey, { completedAt: fut })).reason, 'future_event');
  assert.equal((await c.ingest(s.apiKey, { email: 'kein-at-zeichen' })).reason, 'invalid_payload');

  await c.svc.query('select public.rv_set_tenant_status($1, $2)', [s.tenantId, 'paused']);
  assert.equal((await c.ingest(s.apiKey)).reason, 'tenant_paused');
});

withDb('zweites Ereignis für denselben Kontakt und Standort startet keine zweite Kampagne (V1-Regel)', async (c) => {
  const s = await c.seed();
  const a = await c.ingest(s.apiKey, { eventId: 'e1', contactRef: 'c1', email: 'x@example.test' });
  const b = await c.ingest(s.apiKey, { eventId: 'e2', contactRef: 'c1', email: 'x@example.test' });
  assert.equal(a.result, 'created');
  assert.equal(b.reason, 'campaign_exists');
  assert.equal(await c.count('select count(*) n from review.send_jobs'), 1);
});

// ---------------------------------------------------------------------------
// Versand-Worker (Workflow B)
// ---------------------------------------------------------------------------

withDb('zwei parallele Worker reservieren denselben Job nicht doppelt', async (c) => {
  const s = await c.seed();
  const r = await c.ingest(s.apiKey);
  await c.makeDue(r.job_id);
  const clients = await Promise.all(Array.from({ length: 8 }, () => c.newSvc()));
  const results = await Promise.all(clients.map((x, i) => c.claim(x, `worker-${i}`)));
  const total = results.flat();
  assert.equal(total.length, 1);
  assert.equal(total[0].job_id, r.job_id);
});

withDb('Crash nach Providerannahme: kein blinder Doppelversand, Job wird "unknown"', async (c) => {
  const s = await c.seed();
  const r = await c.ingest(s.apiKey);
  await c.makeDue(r.job_id);
  const [job] = await c.claim();
  assert.equal((await c.markSending(job.job_id)).ok, true);
  // Worker stirbt, Lease läuft ab
  await c.root.query(`update review.send_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [job.job_id]);
  const again = await c.claim(c.svc, 'w2');
  assert.equal(again.length, 0, 'nicht erneut ausgeben');
  assert.equal((await c.one('select status from review.send_jobs where id = $1', [job.job_id])).status, 'unknown');

  // Abstimmung: nachweislich nicht gesendet -> wieder fällig
  const res = await c.svc.query(`select public.rv_resolve_unknown_job($1, 'not_sent') as r`, [job.job_id]);
  assert.equal(res.rows[0].r.ok, true);
  const retry = await c.claim(c.svc, 'w2');
  assert.equal(retry.length, 1);
  assert.equal(retry[0].idempotency_key, job.idempotency_key, 'gleicher Idempotenzschlüssel');
});

withDb('Abstimmung "sent" legt die Erinnerung an', async (c) => {
  const s = await c.seed();
  const r = await c.ingest(s.apiKey);
  await c.makeDue(r.job_id);
  const [job] = await c.claim();
  await c.markSending(job.job_id);
  await c.root.query(`update review.send_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [job.job_id]);
  await c.claim();
  await c.svc.query(`select public.rv_resolve_unknown_job($1, 'sent', 'msg_resolved')`, [job.job_id]);
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'queued'`), 1);
});

withDb('doppelte Erfolgsmeldung und doppelte Abstimmung erzeugen keine zweite Erinnerung', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  const again = await c.complete(sent.jobId, 'sent', sent.msgId);
  assert.equal(again.ok, false);
  const res = await c.svc.query(`select public.rv_resolve_unknown_job($1, 'sent', $2) as r`, [sent.jobId, sent.msgId]);
  assert.equal(res.rows[0].r.ok, false);
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder'`), 1);
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'initial' and status = 'sent'`), 1);
});

withDb('Lease läuft vor "sending" ab: Job geht zurück in die Queue und wird erneut vergeben', async (c) => {
  const s = await c.seed();
  const r = await c.ingest(s.apiKey);
  await c.makeDue(r.job_id);
  const [job] = await c.claim();
  await c.root.query(`update review.send_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [job.job_id]);
  const again = await c.claim(c.svc, 'w2');
  assert.equal(again.length, 1);
  assert.equal(again[0].attempt, 2);
  // alter Worker darf nichts mehr melden
  assert.equal((await c.markSending(job.job_id, 'w1')).ok, false);
});

withDb('Erinnerung nach 48 Stunden, höchstens eine, danach ist die Kampagne abgeschlossen', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  const rem = await c.one(
    `select kind, due_at > now() + interval '47 hours 59 minutes' and due_at < now() + interval '48 hours 1 minute' as ok
       from review.send_jobs where campaign_id = $1 and kind = 'reminder'`, [sent.campaignId]);
  assert.equal(rem.ok, true, 'Erinnerung ist in 48 Stunden fällig');
  assert.equal((await c.claim()).length, 0, 'vor Fälligkeit nichts');

  await c.root.query(`update review.send_jobs set due_at = now() - interval '1 minute' where kind = 'reminder'`);
  const [job] = await c.claim();
  assert.equal(job.kind, 'reminder');
  await c.markSending(job.job_id);
  await c.complete(job.job_id, 'sent', 'msg_reminder');

  assert.equal(await c.count('select count(*) n from review.send_jobs where campaign_id = $1', [sent.campaignId]), 2);
  const camp = await c.one('select status, end_reason from review.campaigns where id = $1', [sent.campaignId]);
  assert.deepEqual([camp.status, camp.end_reason], ['completed', 'reminder_sent']);
  await c.root.query(`update review.send_jobs set due_at = now() - interval '1 minute'`);
  assert.equal((await c.claim()).length, 0, 'es gibt keine dritte Nachricht');
});

withDb('transienter Fehler: Retry mit Backoff, nach max_attempts "failed" und Kampagne gestoppt', async (c) => {
  const s = await c.seed();
  const r = await c.ingest(s.apiKey);
  for (let i = 1; i <= 4; i++) {
    await c.makeDue(r.job_id);
    const [job] = await c.claim();
    assert.equal(job.attempt, i);
    await c.markSending(job.job_id);
    const res = await c.complete(job.job_id, 'transient_error');
    assert.equal(res.status, i < 4 ? 'queued' : 'failed');
    if (i < 4) {
      const due = await c.one('select due_at > now() as future from review.send_jobs where id = $1', [r.job_id]);
      assert.equal(due.future, true, 'Backoff liegt in der Zukunft');
    }
  }
  const camp = await c.one('select status, end_reason from review.campaigns where id = $1', [r.campaign_id]);
  assert.deepEqual([camp.status, camp.end_reason], ['stopped', 'send_failed']);
});

withDb('Versandfenster: an einem nicht erlaubten Wochentag wird nichts gesendet, die Fälligkeit wird verschoben', async (c) => {
  const s = await c.seed();
  const today = (await c.one(`select extract(isodow from now() at time zone timezone)::int as d from review.tenants where id = $1`, [s.tenantId])).d;
  await c.root.query(`update review.tenant_settings set send_weekdays = $2 where tenant_id = $1`, [s.tenantId, [(today % 7) + 1]]);
  const r = await c.ingest(s.apiKey);
  await c.makeDue(r.job_id);
  assert.equal((await c.claim()).length, 0);
  const j = await c.one('select status, due_at > now() as later from review.send_jobs where id = $1', [r.job_id]);
  assert.deepEqual([j.status, j.later], ['queued', true]);
});

withDb('Versandfenster über Sommerzeitwechsel (Europe/Berlin)', async (c) => {
  const slot = async (ts) =>
    new Date((await c.one(`select review.next_send_slot($1::timestamptz, 'Europe/Berlin', '09:00', '18:00', '{1,2,3,4,5}') as s`, [ts])).s).toISOString();
  // Samstagabend vor der Zeitumstellung (29.03.2026) -> Montag 09:00 MESZ = 07:00 UTC
  assert.equal(await slot('2026-03-28T20:00:00Z'), '2026-03-30T07:00:00.000Z');
  // Freitag vor der Umstellung, 07:00 Ortszeit (MEZ) -> 09:00 MEZ = 08:00 UTC
  assert.equal(await slot('2026-03-27T06:00:00Z'), '2026-03-27T08:00:00.000Z');
  // Herbst: Samstag vor 25.10.2026 -> Montag 09:00 MEZ = 08:00 UTC
  assert.equal(await slot('2026-10-24T12:00:00Z'), '2026-10-26T08:00:00.000Z');
  // innerhalb des Fensters: sofort
  assert.equal(await slot('2026-11-11T10:00:00Z'), '2026-11-11T10:00:00.000Z');
  // nach Fensterende am Freitag -> Montag
  assert.equal(await slot('2026-11-13T17:30:00Z'), '2026-11-16T08:00:00.000Z');
});

withDb('Tageslimit: nach einer Störung werden nicht alle Jobs auf einmal nachgeholt', async (c) => {
  const s = await c.seed({ maxPerDay: 1 });
  const a = await c.ingest(s.apiKey);
  const b = await c.ingest(s.apiKey);
  await c.makeDue(a.job_id);
  await c.makeDue(b.job_id);
  assert.equal((await c.claim()).length, 1);
  assert.equal((await c.claim()).length, 0);
});

withDb('Testmodus: nur freigegebene Testadressen erhalten E-Mails, alle anderen Dry Run', async (c) => {
  const s = await c.seed({ testMode: true, testRecipients: ['OK@Example.test'] });
  const ok = await c.ingest(s.apiKey, { email: 'ok@example.test' });
  const other = await c.ingest(s.apiKey, { email: 'fremd@example.test' });
  await c.makeDue(ok.job_id);
  await c.makeDue(other.job_id);
  const claimed = await c.claim();
  assert.deepEqual(claimed.map((x) => x.job_id), [ok.job_id]);
  const dry = await c.one(
    `select j.status, k.status as camp, k.end_reason from review.send_jobs j
       join review.campaigns k on k.id = j.campaign_id where j.id = $1`, [other.job_id]);
  assert.deepEqual([dry.status, dry.camp, dry.end_reason], ['dry_run', 'stopped', 'dry_run']);
});

withDb('zu spät gewordene Anfrage wird nicht nachgeholt (expired)', async (c) => {
  const s = await c.seed({ staleHours: 72 });
  const r = await c.ingest(s.apiKey);
  await c.root.query(`update review.send_jobs set due_at = now() - interval '100 hours' where id = $1`, [r.job_id]);
  assert.equal((await c.claim()).length, 0);
  const camp = await c.one('select status, end_reason from review.campaigns where id = $1', [r.campaign_id]);
  assert.deepEqual([camp.status, camp.end_reason], ['stopped', 'expired']);
});

// ---------------------------------------------------------------------------
// Stopps: Abmeldung, Hard Bounce, Beschwerde, Pausen
// ---------------------------------------------------------------------------

withDb('Abmeldung: GET ändert nichts, bewusste Aktion sperrt und stoppt die Erinnerung', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  const check = await c.svc.query('select public.rv_unsubscribe_check($1) as ok', [sent.unsubToken]);
  assert.equal(check.rows[0].ok, true);
  assert.equal(await c.count('select count(*) n from review.suppressions'), 0, 'Prüfen verändert nichts');

  const un = await c.svc.query('select public.rv_unsubscribe($1) as ok', [sent.unsubToken]);
  assert.equal(un.rows[0].ok, true);
  assert.equal(await c.count('select count(*) n from review.suppressions'), 1);
  assert.equal(await c.count(`select count(*) n from review.send_jobs where status = 'cancelled' and kind = 'reminder'`), 1);
  await c.root.query(`update review.send_jobs set due_at = now() - interval '1 minute'`);
  assert.equal((await c.claim()).length, 0);
  // neue Anfrage für dieselbe Adresse wird abgelehnt
  const again = await c.ingest(s.apiKey, { email: sent.email, contactRef: 'neu' });
  assert.equal(again.reason, 'suppressed');
  // Löschen des Kontakts hebt die Sperre nicht auf
  await c.root.query('delete from review.contacts');
  assert.equal(await c.count('select count(*) n from review.suppressions'), 1);
});

withDb('Abmeldung zwischen Reservierung und Versand verhindert den Versand', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  await c.root.query(`update review.send_jobs set due_at = now() - interval '1 minute' where kind = 'reminder'`);
  const [rem] = await c.claim();
  await c.svc.query('select public.rv_unsubscribe($1)', [sent.unsubToken]);
  assert.equal((await c.markSending(rem.job_id)).ok, false);
});

withDb('Hard Bounce und Beschwerde sperren sofort und stoppen die Erinnerung; Ereignisse sind idempotent und reihenfolgesicher', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  const ev = (id, type) =>
    c.svc.query(`select public.rv_apply_provider_event('resend', $1, $2, now(), $3) as r`, [id, type, sent.msgId]).then((r) => r.rows[0].r.result);

  assert.equal(await ev('evt-1', 'delivered'), 'applied');
  assert.equal(await ev('evt-1', 'delivered'), 'duplicate');
  assert.equal(await ev('evt-2', 'bounced_hard'), 'applied');
  assert.equal(await ev('evt-3', 'delivered'), 'applied', 'verspätetes Ereignis wird gespeichert');
  assert.equal((await c.one('select delivery_state from review.send_jobs where id = $1', [sent.jobId])).delivery_state, 'bounced');
  assert.equal((await c.one(`select reason from review.suppressions`)).reason, 'hard_bounce');
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'cancelled'`), 1);

  const unmatched = await c.svc.query(`select public.rv_apply_provider_event('resend', 'evt-9', 'delivered', now(), 'msg_unbekannt') as r`);
  assert.equal(unmatched.rows[0].r.result, 'unmatched');
  const ignored = await c.svc.query(`select public.rv_apply_provider_event('resend', 'evt-10', 'opened', now(), $1) as r`, [sent.msgId]);
  assert.equal(ignored.rows[0].r.result, 'ignored');
});

withDb('Beschwerde sperrt ebenfalls', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  await c.svc.query(`select public.rv_apply_provider_event('resend', 'evt-c', 'complained', now(), $1)`, [sent.msgId]);
  assert.equal((await c.one(`select reason from review.suppressions`)).reason, 'complaint');
  assert.equal(await c.count(`select count(*) n from review.campaigns where status = 'stopped' and end_reason = 'complaint'`), 1);
});

withDb('Mandanten- und globale Pause stoppen den Versand, Fortsetzung läuft ohne Verlust weiter', async (c) => {
  const s = await c.seed();
  await c.sentCampaign(s);
  await c.root.query(`update review.send_jobs set due_at = now() - interval '1 minute' where kind = 'reminder'`);

  await c.svc.query('select public.rv_set_tenant_status($1, $2)', [s.tenantId, 'paused']);
  assert.equal((await c.claim()).length, 0);
  await c.svc.query('select public.rv_set_tenant_status($1, $2)', [s.tenantId, 'active']);

  await c.svc.query('select public.rv_set_global_send_paused(true)');
  assert.equal((await c.claim()).length, 0);
  await c.svc.query('select public.rv_set_global_send_paused(false)');

  const claimed = await c.claim();
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].kind, 'reminder');
});

// ---------------------------------------------------------------------------
// Klick-Erfassung
// ---------------------------------------------------------------------------

withDb('Rohaufruf (Scanner) stoppt nichts, bewusster Klick stoppt die Erinnerung und liefert nur die geprüfte URL', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  const click = (token, cls) => c.svc.query('select public.rv_register_click($1, $2) as r', [token, cls]).then((r) => r.rows[0].r);

  const raw = await click(sent.clickToken, 'raw');
  assert.deepEqual(raw, { valid: true, studio: 'Studio' }, 'Rohaufruf liefert keine URL');
  assert.equal((await c.one('select status from review.campaigns where id = $1', [sent.campaignId])).status, 'active');
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'queued'`), 1);

  const q = await click(sent.clickToken, 'qualified');
  assert.deepEqual(q, { valid: true, studio: 'Studio', url: 'https://g.page/r/ABC123/review' });
  const camp = await c.one('select status, end_reason from review.campaigns where id = $1', [sent.campaignId]);
  assert.deepEqual([camp.status, camp.end_reason], ['completed', 'qualified_click']);
  assert.equal(await c.count(`select count(*) n from review.send_jobs where kind = 'reminder' and status = 'cancelled'`), 1);
  assert.equal(await c.count(`select count(*) n from review.click_events where click_class = 'raw'`), 1);
  assert.equal(await c.count(`select count(*) n from review.click_events where click_class = 'qualified'`), 1);
});

withDb('ungültige, abgelaufene und falsche Tokens verraten nichts und erlauben keine Weiterleitung', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  const click = (token, cls = 'qualified') => c.svc.query('select public.rv_register_click($1, $2) as r', [token, cls]).then((r) => r.rows[0].r);
  assert.deepEqual(await click('x'.repeat(40)), { valid: false });
  assert.deepEqual(await click(''), { valid: false });
  assert.deepEqual(await click(sent.unsubToken), { valid: false }, 'Abmeldetoken ist kein Klicktoken');
  await c.root.query(`update review.link_tokens set expires_at = now() - interval '1 day'`);
  assert.deepEqual(await click(sent.clickToken), { valid: false });
  const unsub = await c.svc.query('select public.rv_unsubscribe($1) as ok', [sent.unsubToken]);
  assert.equal(unsub.rows[0].ok, false);
});

withDb('Tokens werden nur als Hash gespeichert', async (c) => {
  const s = await c.seed();
  const sent = await c.sentCampaign(s);
  for (const tok of [sent.clickToken, sent.unsubToken]) {
    assert.equal(await c.count('select count(*) n from review.link_tokens where token_hash = review.token_hash($1)', [tok]), 1);
    const raw = await c.count(
      `select count(*) n from review.link_tokens t where strpos(t::text, $1) > 0 or strpos(encode(t.token_hash, 'hex'), $1) > 0`, [tok]);
    assert.equal(raw, 0, 'Klartext-Token darf nirgends in der Zeile stehen');
  }
});

withDb('Weiterleitungsziele: nur Google-Hosts, keine Open-Redirect-Pfade', async (c) => {
  const s = await c.seed();
  const tryUrl = (url) =>
    c.root.query(`insert into review.locations (tenant_id, name, google_review_url) values ($1, 'X', $2)`, [s.tenantId, url]).then(() => 'ok', (e) => e.code);
  assert.equal(await tryUrl('https://g.page/r/XYZ/review'), 'ok');
  assert.equal(await tryUrl('https://search.google.com/local/writereview?placeid=ChIJ123'), 'ok');
  for (const bad of [
    'https://evil.example/', 'http://g.page/r/XYZ/review', 'https://g.page.evil.com/x',
    'https://evil@g.page/x', 'https://www.google.com/url?q=https://evil.example', 'https://www.google.com/amp/s/evil.example',
    'javascript:alert(1)', 'https://g.page/r/ X/review',
  ]) {
    assert.equal(await tryUrl(bad), '23514', bad);
  }
});

// ---------------------------------------------------------------------------
// Mandantentrennung und Rechte
// ---------------------------------------------------------------------------

withDb('Mandantentrennung: Key leitet den Mandanten ab, fremde Beziehungen sind im Schema unmöglich', async (c) => {
  const a = await c.seed({ name: 'A' });
  const b = await c.seed({ name: 'B' });
  const r = await c.ingest(b.apiKey, { email: 'gleich@example.test', contactRef: 'ref-1' });
  assert.equal(r.result, 'created');
  assert.equal((await c.one('select tenant_id, location_id from review.campaigns where id = $1', [r.campaign_id])).tenant_id, b.tenantId);

  // gleiche Adresse und gleiche externe Kennung in anderem Mandanten sind erlaubt
  const r2 = await c.ingest(a.apiKey, { email: 'gleich@example.test', contactRef: 'ref-1' });
  assert.equal(r2.result, 'created');

  // Sperre in A wirkt nicht in B
  await c.root.query(`insert into review.suppressions (tenant_id, email_hash, reason) values ($1, review.email_hash('nur-a@example.test'), 'manual')`, [a.tenantId]);
  assert.equal((await c.ingest(a.apiKey, { email: 'nur-a@example.test' })).reason, 'suppressed');
  assert.equal((await c.ingest(b.apiKey, { email: 'nur-a@example.test' })).result, 'created');

  // Standort von B an Kampagne von A hängen: Fremdschlüsselverletzung
  const ev = await c.one('select id, contact_id from review.completion_events where tenant_id = $1 limit 1', [a.tenantId]);
  const err = await c.root
    .query(`insert into review.campaigns (tenant_id, location_id, contact_id, event_id) values ($1, $2, $3, $4)`,
      [a.tenantId, b.locationId, ev.contact_id, ev.id])
    .then(() => null, (e) => e.code);
  assert.equal(err, '23503');
});

withDb('Rechte: anon und authenticated haben keinen Zugriff, service_role nur über RPCs, RLS ist überall aktiv', async (c) => {
  const noRls = await c.root.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'review' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(noRls.rows, []);

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const cl = await c.asRole(role);
    const t = await cl.query('select * from review.tenants').then(() => 'ok', (e) => e.code);
    assert.equal(t, '42501', `${role}: Tabellenzugriff`);
    const f = await cl.query(`select review.email_hash('a@b.de')`).then(() => 'ok', (e) => e.code);
    assert.equal(f, '42501', `${role}: interne Funktion`);
  }
  for (const role of ['anon', 'authenticated']) {
    const cl = await c.asRole(role);
    const rpc = await cl.query(`select public.rv_claim_due_jobs('x')`).then(() => 'ok', (e) => e.code);
    assert.equal(rpc, '42501', `${role}: RPC`);
    const rpc2 = await cl.query(`select public.rv_unsubscribe('x')`).then(() => 'ok', (e) => e.code);
    assert.equal(rpc2, '42501', `${role}: RPC unsubscribe`);
  }
  const svc = await c.asRole('service_role');
  const ok = await svc.query(`select * from public.rv_claim_due_jobs('x')`).then(() => 'ok', (e) => e.code);
  assert.equal(ok, 'ok');
});

withDb('Provider lehnt Zugang ab: Job zurück ohne verbrauchten Versuch, Versand global pausiert, Warnung', async (c) => {
  const s = await c.seed();
  const r = await c.ingest(s.apiKey);
  await c.makeDue(r.job_id);
  const [job] = await c.claim();
  await c.markSending(job.job_id);
  const res = await c.complete(job.job_id, 'config_error');
  assert.equal(res.paused, true);
  const j = await c.one('select status, attempts from review.send_jobs where id = $1', [job.job_id]);
  assert.deepEqual([j.status, j.attempts], ['queued', 0]);
  assert.equal((await c.claim()).length, 0, 'pausiert');
  const h = (await c.svc.query('select public.rv_ops_health() as r')).rows[0].r;
  assert.ok(h.alerts.some((a) => a.code === 'auto_paused'));
  await c.svc.query('select public.rv_set_global_send_paused(false)');
  assert.equal((await c.claim()).length, 1);
});
