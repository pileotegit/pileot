// Abschluss eines Termins aufnehmen (Workflow A). Öffentlicher Vertrag für Terminsoftware,
// n8n-Formular oder andere Quellen.
//
//   POST  Authorization: Bearer rvk_...
//   {
//     "event_id": "termin-4711",            eindeutig pro Quelle (Idempotenz)
//     "contact_ref": "kundin-123",          stabile Kennung der Kundin in der Quelle
//     "email": "kundin@example.de",
//     "first_name": "Anna",                 optional
//     "completed_at": "2026-11-11T10:00:00+01:00",
//     "consent": { "basis": "explicit_opt_in", "source": "Anmeldeformular", "documented_at": "..." }
//   }
//
// Antworten: 201 created, 200 duplicate, 401 Key ungültig, 422 rejected (mit reason), 400 Format.
// Der Mandant wird ausschließlich aus dem Key abgeleitet.

import type { Deps } from '../_shared/types.ts';
import { corsHeaders, json, readBody, safeJson } from '../_shared/http.ts';

export async function handler(req: Request, deps: Deps): Promise<Response> {
  // CORS nur für das Eintragsformular (web/eintragen) auf den freigegebenen Origins.
  const cors = corsHeaders(req, deps.env, 'content-type, authorization');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const res = await inner(req, deps);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

async function inner(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });

  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer (rvk_[0-9a-f]{64})$/.exec(auth);
  if (!m) return json({ result: 'rejected', reason: 'integration_invalid' }, 401);

  const raw = await readBody(req, 8192);
  if (raw === null) return json({ error: 'payload_too_large' }, 413);
  const b = safeJson(raw);
  if (!b || typeof b !== 'object') return json({ error: 'invalid_json' }, 400);

  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const completedAt = str(b.completed_at);
  if (!completedAt || Number.isNaN(Date.parse(completedAt))) {
    return json({ result: 'rejected', reason: 'invalid_payload' }, 422);
  }
  const consent = b.consent && typeof b.consent === 'object' ? b.consent : {};
  const consentAt = str(consent.documented_at);
  if (consentAt !== null && Number.isNaN(Date.parse(consentAt))) {
    return json({ result: 'rejected', reason: 'invalid_payload' }, 422);
  }

  const res = await deps.rpc('rv_ingest_completion', {
    p_api_key: m[1],
    p_external_event_id: str(b.event_id),
    p_external_contact_ref: str(b.contact_ref),
    p_email: str(b.email),
    p_first_name: str(b.first_name),
    p_completed_at: completedAt,
    p_consent_basis: str(consent.basis),
    p_consent_source: str(consent.source),
    p_consent_documented_at: consentAt,
  });

  if (res?.result === 'created') return json(res, 201);
  if (res?.result === 'duplicate') return json(res, 200);
  if (res?.reason === 'integration_invalid') return json({ result: 'rejected', reason: 'integration_invalid' }, 401);
  return json({ result: 'rejected', reason: res?.reason ?? 'unknown' }, 422);
}
