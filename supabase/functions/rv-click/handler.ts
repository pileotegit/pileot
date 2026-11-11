// Klick-Erfassung. Die sichtbare Zwischenseite ist statisch (web/r/), weil Supabase auf der
// Standarddomain kein HTML ausliefert. Diese Funktion spricht nur JSON.
//
//   GET  ?t=TOKEN                      -> 303 auf die statische Seite (falls direkt verlinkt)
//   POST {"t": TOKEN, "class": "raw"}       Seite geladen (Mensch mit JavaScript), stoppt nichts
//   POST {"t": TOKEN, "class": "qualified"} Button geklickt: stoppt Erinnerung, liefert Google-URL
//
// Ungültige Tokens: {"valid": false}, Status 404, keine weiteren Angaben.

import type { Deps } from '../_shared/types.ts';
import { corsHeaders, isToken, json, readBody, redirect, safeJson, text } from '../_shared/http.ts';

const ALLOWED_HOSTS = new Set(['g.page', 'search.google.com', 'www.google.com', 'maps.app.goo.gl', 'g.co']);

export function isAllowedTarget(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (req.method === 'GET' || req.method === 'HEAD') {
    const t = new URL(req.url).searchParams.get('t') ?? '';
    const target = new URL(deps.env.CLICK_PAGE_URL);
    if (isToken(t)) target.searchParams.set('t', t);
    return redirect(target.toString());
  }
  if (req.method !== 'POST') return text('Method not allowed', 405, { allow: 'GET, POST, OPTIONS' });

  const body = safeJson(await readBody(req, 2048));
  const t = body?.t;
  const cls = body?.class;
  if (!isToken(t) || (cls !== 'raw' && cls !== 'qualified')) return json({ valid: false }, 404, cors);

  const res = await deps.rpc('rv_register_click', { p_token: t, p_class: cls });
  if (!res?.valid) return json({ valid: false }, 404, cors);
  if (cls === 'raw') return json({ valid: true, studio: res.studio ?? null }, 200, cors);

  // Zweite Verteidigungslinie: nur geprüfte Google-Ziele ausgeben.
  if (!isAllowedTarget(res.url)) {
    deps.log('click_target_rejected');
    return json({ valid: false }, 404, cors);
  }
  return json({ valid: true, studio: res.studio ?? null, url: res.url }, 200, cors);
}
