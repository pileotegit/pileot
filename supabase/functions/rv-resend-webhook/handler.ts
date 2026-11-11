// Provider-Ereignisse von Resend (Workflow C). Bewusst als Edge Function statt n8n: Die
// Signatur muss am unveränderten Rohbody geprüft werden.
//
// Antworten: 2xx = verarbeitet oder bewusst ignoriert; 401 = Signatur ungültig;
// 409 = Job zur Mail noch nicht bekannt (Resend stellt später erneut zu).

import type { Deps } from '../_shared/types.ts';
import { json, readBody, safeJson } from '../_shared/http.ts';
import { verify } from '../_shared/svix.ts';

export function mapEvent(p: any): string | null {
  switch (p?.type) {
    case 'email.delivered':
      return 'delivered';
    case 'email.delivery_delayed':
      return 'delayed';
    case 'email.bounced':
      return p?.data?.bounce?.type === 'Permanent' ? 'bounced_hard' : 'bounced_soft';
    case 'email.suppressed':
      // Resend hat nicht zugestellt, weil die Adresse dort gesperrt ist: wie Hard Bounce behandeln.
      return 'bounced_hard';
    case 'email.complained':
      return 'complained';
    default:
      return null;
  }
}

const isJobMail = (p: any) => {
  const tags = p?.data?.tags;
  if (Array.isArray(tags)) return tags.some((t: any) => t?.name === 'rv' && t?.value === 'job');
  return tags && typeof tags === 'object' && tags.rv === 'job';
};

export async function handler(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = deps.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'not_configured' }, 503);

  const raw = await readBody(req, 256 * 1024);
  if (raw === null) return json({ error: 'payload_too_large' }, 413);
  const v = await verify(secret, req.headers, raw, deps.now());
  if (!v.ok) {
    deps.log('webhook_rejected', { reason: v.reason });
    return json({ error: 'invalid_signature' }, 401);
  }

  const p = safeJson(raw);
  const eventType = mapEvent(p);
  if (!eventType) return json({ result: 'ignored' });
  const messageId = p?.data?.email_id;
  if (typeof messageId !== 'string' || !messageId) return json({ result: 'ignored' });

  const occurredAt = typeof p.created_at === 'string' && !Number.isNaN(Date.parse(p.created_at)) ? p.created_at : deps.now().toISOString();
  const res = await deps.rpc('rv_apply_provider_event', {
    p_provider: 'resend',
    p_event_id: req.headers.get('svix-id'),
    p_event_type: eventType,
    p_occurred_at: occurredAt,
    p_provider_message_id: messageId,
  });

  if (res?.result === 'unmatched') {
    // Mails anderer Art (Wochenbericht, Warnungen) oder Ereignisse älter als einen Tag: annehmen.
    const ageMs = deps.now().getTime() - Date.parse(occurredAt);
    if (!isJobMail(p) || ageMs > 24 * 3600e3) return json({ result: 'ignored' });
    return json({ result: 'unmatched' }, 409);
  }
  return json({ result: res?.result ?? 'applied' });
}
