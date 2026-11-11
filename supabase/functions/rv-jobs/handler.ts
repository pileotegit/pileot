// Interne Arbeitsschritte, von n8n zeitgesteuert ausgelöst. Geschützt mit WORKER_SECRET im
// Header x-rv-worker-secret. Jeder Schritt ist wiederholbar: Zustand liegt in der Datenbank.
//
//   POST {"action": "send"}           Workflow B: fällige Anfragen versenden
//   POST {"action": "weekly-report"}  Workflow E: Wochenberichte der Vorwoche
//   POST {"action": "google-sync"}    Workflow D: Google-Bewertungen abgleichen
//   POST {"action": "ops"}            Workflow F: Betriebsprüfung, Warnmail
//   POST {"action": "purge"}          Workflow F: Aufbewahrungsfristen

import type { Deps } from '../_shared/types.ts';
import { json, readBody, safeJson, timingSafeEqual } from '../_shared/http.ts';
import { formatFrom, sendMail } from '../_shared/resend.ts';
import { renderOpsAlert, renderRequest, renderWeeklyReport } from '../_shared/templates.ts';
import { accessToken, fetchReviews, googleConfigured } from '../_shared/google.ts';

const MAX_BATCHES = 4;
const BATCH_SIZE = 5;
const TIME_BUDGET_MS = 100_000;

function linkUrl(base: string, token: string): string {
  const u = new URL(base);
  u.searchParams.set('t', token);
  return u.toString();
}

export async function runSend(deps: Deps, worker: string) {
  const started = deps.now().getTime();
  const summary = { claimed: 0, sent: 0, skipped: 0, transient: 0, permanent: 0, unknown: 0, config_error: 0 };

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if (deps.now().getTime() - started > TIME_BUDGET_MS) break;
    const jobs: any[] = await deps.rpc('rv_claim_due_jobs', { p_worker: worker, p_limit: BATCH_SIZE, p_lease_seconds: 300 });
    if (!jobs?.length) break;
    summary.claimed += jobs.length;

    for (const j of jobs) {
      const mark = await deps.rpc('rv_mark_job_sending', { p_job_id: j.job_id, p_worker: worker });
      if (!mark?.ok) {
        summary.skipped++;
        continue;
      }
      const clickUrl = linkUrl(deps.env.CLICK_PAGE_URL, j.click_token);
      const unsubPage = linkUrl(deps.env.UNSUB_PAGE_URL, j.unsub_token);
      const oneClick = linkUrl(`${deps.env.FUNCTIONS_BASE_URL}/rv-unsubscribe`, j.unsub_token);
      const content = renderRequest(j.kind, {
        studio: j.studio_name ?? j.sender_name,
        firstName: j.first_name,
        clickUrl,
        unsubUrl: unsubPage,
      });
      const result = await sendMail(
        deps,
        {
          from: formatFrom(j.sender_name, j.sender_email),
          to: j.to_email,
          replyTo: j.reply_to_email,
          subject: content.subject,
          html: content.html,
          text: content.text,
          headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
          tags: [{ name: 'rv', value: 'job' }, { name: 'kind', value: j.kind }],
        },
        j.idempotency_key,
      );

      await deps.rpc('rv_complete_job', {
        p_job_id: j.job_id,
        p_worker: worker,
        p_outcome: result.outcome,
        p_provider_message_id: result.outcome === 'sent' ? result.id : null,
      });
      if (result.outcome === 'sent') summary.sent++;
      else {
        deps.log('send_not_ok', { job_id: j.job_id, outcome: result.outcome, detail: result.detail });
        if (result.outcome === 'transient_error') summary.transient++;
        else if (result.outcome === 'permanent_error') summary.permanent++;
        else if (result.outcome === 'unknown_outcome') summary.unknown++;
        else summary.config_error++;
      }
      if (result.outcome === 'config_error') {
        // Restliche Jobs dieses Batches ohne verbrauchten Versuch zurückgeben.
        for (const rest of jobs.slice(jobs.indexOf(j) + 1)) {
          await deps.rpc('rv_complete_job', { p_job_id: rest.job_id, p_worker: worker, p_outcome: 'config_error', p_provider_message_id: null });
        }
        return { ...summary, aborted: 'config_error' };
      }
    }
    if (jobs.length < BATCH_SIZE) break;
  }
  return summary;
}

export async function runWeeklyReport(deps: Deps) {
  const reports: any[] = await deps.rpc('rv_claim_weekly_reports', { p_now: deps.now().toISOString() });
  const out = { claimed: reports?.length ?? 0, sent: 0, failed: 0 };
  for (const r of reports ?? []) {
    const content = renderWeeklyReport(r.tenant_name, r.report);
    const res = await sendMail(
      deps,
      {
        from: deps.env.OPS_SENDER ?? formatFrom('PILEOT', r.sender_email),
        to: r.recipient,
        replyTo: deps.env.OPS_ALERT_EMAIL,
        subject: content.subject,
        html: content.html,
        text: content.text,
        tags: [{ name: 'rv', value: 'report' }],
      },
      r.idempotency_key,
    );
    if (res.outcome === 'sent') {
      await deps.rpc('rv_complete_weekly_report', { p_tenant_id: r.tenant_id, p_week_start: r.week_start, p_provider_message_id: res.id });
      out.sent++;
    } else {
      // Reservierung läuft nach 30 Minuten ab, der nächste Lauf versucht es mit demselben Schlüssel.
      deps.log('report_not_sent', { tenant_id: r.tenant_id, outcome: res.outcome, detail: res.detail });
      out.failed++;
    }
  }
  return out;
}

export async function runGoogleSync(deps: Deps) {
  if (!googleConfigured(deps)) return { status: 'not_configured' };
  const locations: any[] = await deps.rpc('rv_list_google_locations', {});
  if (!locations?.length) return { status: 'ok', locations: 0 };
  let token: string;
  try {
    token = await accessToken(deps);
  } catch (e) {
    for (const l of locations) await deps.rpc('rv_mark_google_sync_error', { p_location_id: l.location_id, p_error: (e as Error).message });
    return { status: 'error', error: (e as Error).message };
  }
  const results: any[] = [];
  for (const l of locations) {
    try {
      const reviews = await fetchReviews(deps, token, l.google_location_id, l.last_sync_at);
      const r = await deps.rpc('rv_upsert_google_reviews', { p_location_id: l.location_id, p_reviews: reviews });
      results.push({ location_id: l.location_id, ...r });
    } catch (e) {
      await deps.rpc('rv_mark_google_sync_error', { p_location_id: l.location_id, p_error: (e as Error).message });
      results.push({ location_id: l.location_id, error: (e as Error).message });
    }
  }
  return { status: 'ok', locations: locations.length, results };
}

export async function runOps(deps: Deps) {
  const health = await deps.rpc('rv_ops_health', { p_now: deps.now().toISOString() });
  let alert: 'none' | 'sent' | 'already_sent_today' | 'failed' | 'not_configured' = 'none';
  if (health?.alerts?.length && deps.env.OPS_ALERT_EMAIL && deps.env.OPS_SENDER) {
    // Höchstens eine Warnmail pro Tag und Warnkombination (fester Idempotenzschlüssel).
    const day = deps.now().toISOString().slice(0, 10);
    const codes = health.alerts.map((a: any) => a.code).sort().join('+');
    const content = renderOpsAlert(health);
    const res = await sendMail(
      deps,
      {
        from: deps.env.OPS_SENDER,
        to: deps.env.OPS_ALERT_EMAIL,
        subject: content.subject,
        html: content.html,
        text: content.text,
        tags: [{ name: 'rv', value: 'ops' }],
      },
      `rv-ops-${day}-${codes}`,
    );
    // 409: heute wurde für diese Warnkombination schon eine Mail mit anderem Stand angenommen.
    alert = res.outcome === 'sent' ? 'sent' : res.detail.startsWith('409') ? 'already_sent_today' : 'failed';
  } else if (health?.alerts?.length) {
    alert = 'not_configured';
  }
  return { ...health, alert };
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = deps.env.WORKER_SECRET;
  const given = req.headers.get('x-rv-worker-secret') ?? '';
  if (!secret || secret.length < 32 || !timingSafeEqual(given, secret)) return json({ error: 'unauthorized' }, 401);

  const body = safeJson(await readBody(req, 1024));
  const action = body?.action;
  const worker = `edge-${crypto.randomUUID().slice(0, 8)}`;
  try {
    switch (action) {
      case 'send':
        return json({ action, ...(await runSend(deps, worker)) });
      case 'weekly-report':
        return json({ action, ...(await runWeeklyReport(deps)) });
      case 'google-sync':
        return json({ action, ...(await runGoogleSync(deps)) });
      case 'ops':
        return json({ action, ...(await runOps(deps)) });
      case 'purge':
        return json({ action, ...(await deps.rpc('rv_purge_expired', { p_now: deps.now().toISOString() })) });
      default:
        return json({ error: 'unknown_action' }, 400);
    }
  } catch (e) {
    deps.log('job_failed', { action, error: (e as Error).message });
    return json({ action, error: 'internal_error' }, 500);
  }
}
