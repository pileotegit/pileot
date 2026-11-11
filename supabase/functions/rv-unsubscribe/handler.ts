// Abmeldung.
//
//   GET  ?t=TOKEN  -> 303 auf die statische Abmeldeseite (Mailprogramme ohne One-Click öffnen
//                     den List-Unsubscribe-Link im Browser). GET ändert nie etwas.
//   POST ?t=TOKEN mit Body "List-Unsubscribe=One-Click" (RFC 8058, z. B. Gmail-Button)
//                  -> Abmeldung, 200
//   POST JSON {"t": TOKEN, "action": "check" | "confirm"}  von der statischen Seite

import type { Deps } from '../_shared/types.ts';
import { corsHeaders, isToken, json, readBody, redirect, safeJson, text } from '../_shared/http.ts';

export async function handler(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);

  if (req.method === 'GET' || req.method === 'HEAD') {
    const t = url.searchParams.get('t') ?? '';
    const target = new URL(deps.env.UNSUB_PAGE_URL);
    if (isToken(t)) target.searchParams.set('t', t);
    return redirect(target.toString());
  }
  if (req.method !== 'POST') return text('Method not allowed', 405, { allow: 'GET, POST, OPTIONS' });

  const raw = await readBody(req, 2048);
  const ctype = req.headers.get('content-type') ?? '';

  // RFC 8058 One-Click
  if (ctype.startsWith('application/x-www-form-urlencoded') || ctype.startsWith('multipart/form-data')) {
    const params = new URLSearchParams(raw ?? '');
    const t = url.searchParams.get('t') ?? params.get('t') ?? '';
    if (params.get('List-Unsubscribe') !== 'One-Click' || !isToken(t)) return text('Ungültige Anfrage', 400);
    const ok = await deps.rpc('rv_unsubscribe', { p_token: t });
    return ok ? text('Abgemeldet') : text('Link ungültig oder abgelaufen', 404);
  }

  const body = safeJson(raw);
  const t = body?.t;
  if (!isToken(t)) return json({ valid: false }, 404, cors);
  if (body.action === 'check') {
    const valid = await deps.rpc('rv_unsubscribe_check', { p_token: t });
    return json({ valid: !!valid }, valid ? 200 : 404, cors);
  }
  if (body.action === 'confirm') {
    const ok = await deps.rpc('rv_unsubscribe', { p_token: t });
    return json({ ok: !!ok }, ok ? 200 : 404, cors);
  }
  return json({ valid: false }, 400, cors);
}
