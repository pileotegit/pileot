import pg from 'pg';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const { Client } = pg;

const base = {
  host: process.env.PGHOST ?? '/tmp',
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? 'pgtest',
};

const rnd = () => randomBytes(4).toString('hex');

/** Jeder Test bekommt eine frische Datenbank mit allen Migrationen. */
export function withDb(name, fn) {
  test(name, async () => {
    const dbName = 'rvtest_' + rnd();
    const admin = new Client({ ...base, database: 'postgres' });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();

    const opened = [];
    const open = async (extra = {}) => {
      const c = new Client({ ...base, database: dbName, ...extra });
      await c.connect();
      opened.push(c);
      return c;
    };

    try {
      const root = await open();
      await root.query(readFileSync(new URL('./bootstrap.sql', import.meta.url), 'utf8'));
      const dir = new URL('../../supabase/migrations/', import.meta.url);
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
        await root.query(readFileSync(new URL(f, dir), 'utf8'));
      }
      await root.query('select public.rv_set_global_send_paused(false)');

      const svc = await open({ options: '-c role=service_role' });
      const ctx = {
        root,
        svc,
        newSvc: () => open({ options: '-c role=service_role' }),
        asRole: (role) => open({ options: `-c role=${role}` }),
        seed: (o) => seedTenant(ctx, o),
        ingest: (apiKey, o) => ingest(svc, apiKey, o),
        claim: (client = svc, worker = 'w1', limit = 5) =>
          client.query('select * from public.rv_claim_due_jobs($1, $2, 300)', [worker, limit]).then((r) => r.rows),
        makeDue: (jobId) =>
          root.query(`update review.send_jobs set due_at = now() - interval '1 minute' where id = $1`, [jobId]),
        markSending: (jobId, worker = 'w1') =>
          svc.query('select public.rv_mark_job_sending($1, $2) as r', [jobId, worker]).then((r) => r.rows[0].r),
        complete: (jobId, outcome, msgId = null, worker = 'w1') =>
          svc.query('select public.rv_complete_job($1, $2, $3, $4) as r', [jobId, worker, outcome, msgId]).then((r) => r.rows[0].r),
        sentCampaign: (s, o) => sentCampaign(ctx, s, o),
        one: (sql, params) => root.query(sql, params).then((r) => r.rows[0]),
        count: (sql, params) => root.query(sql, params).then((r) => Number(r.rows[0].n)),
      };
      await fn(ctx);
    } finally {
      for (const c of opened) {
        try { await c.end(); } catch { /* ignorieren */ }
      }
      const a = new Client({ ...base, database: 'postgres' });
      await a.connect();
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    }
  });
}

async function seedTenant(ctx, o = {}) {
  const { root, svc } = ctx;
  const t = await root.query('insert into review.tenants (name, status) values ($1, $2) returning id', [
    o.name ?? 'Test Studio',
    o.status ?? 'active',
  ]);
  const tenantId = t.rows[0].id;
  const l = await root.query(
    `insert into review.locations (tenant_id, name, google_review_url)
     values ($1, 'Studio', 'https://g.page/r/ABC123/review') returning id`,
    [tenantId],
  );
  const locationId = l.rows[0].id;
  await root.query(
    `insert into review.tenant_settings
       (tenant_id, sender_name, sender_email, reply_to_email, report_recipient_email,
        send_window_start, send_window_end, send_weekdays, test_mode, test_recipients,
        max_sends_per_day, stale_after_hours)
     values ($1, 'Studio', 'bewertung@mail.example.test', 'inhaberin@example.test', 'inhaberin@example.test',
             '00:00', '24:00', '{1,2,3,4,5,6,7}', $2, $3, $4, $5)`,
    [tenantId, o.testMode ?? false, o.testRecipients ?? [], o.maxPerDay ?? 100, o.staleHours ?? 72],
  );
  const k = await svc.query('select public.rv_create_integration($1, $2, $3) as key', [tenantId, locationId, 'test-adapter']);
  return { tenantId, locationId, apiKey: k.rows[0].key };
}

export async function ingest(client, apiKey, o = {}) {
  const now = new Date().toISOString();
  const r = await client.query(
    'select public.rv_ingest_completion($1, $2, $3, $4, $5, $6, $7, $8, $9) as r',
    [
      apiKey,
      o.eventId ?? 'evt-' + randomUUID(),
      o.contactRef ?? 'c-' + randomUUID(),
      o.email ?? `kundin-${rnd()}@example.test`,
      o.firstName === undefined ? 'Anna' : o.firstName,
      o.completedAt ?? now,
      o.consent === undefined ? 'explicit_opt_in' : o.consent,
      o.consentSource === undefined ? 'Testformular' : o.consentSource,
      o.consentAt === undefined ? now : o.consentAt,
    ],
  );
  return r.rows[0].r;
}

/** Kampagne anlegen, Erstversand reservieren, "senden" und als gesendet melden. */
async function sentCampaign(ctx, s, o = {}) {
  const email = o.email ?? `k-${rnd()}@example.test`;
  const r = await ctx.ingest(s.apiKey, { email, ...(o.ingest ?? {}) });
  assert.equal(r.result, 'created', JSON.stringify(r));
  await ctx.makeDue(r.job_id);
  const claimed = await ctx.claim();
  const job = claimed.find((x) => x.job_id === r.job_id);
  assert.ok(job, 'Erstversand wurde reserviert');
  const sending = await ctx.markSending(job.job_id);
  assert.equal(sending.ok, true);
  const msgId = 'msg_' + rnd();
  const done = await ctx.complete(job.job_id, 'sent', msgId);
  assert.equal(done.status, 'sent');
  return {
    email,
    campaignId: r.campaign_id,
    jobId: job.job_id,
    msgId,
    clickToken: job.click_token,
    unsubToken: job.unsub_token,
  };
}
