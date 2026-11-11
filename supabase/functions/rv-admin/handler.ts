// Admin-Schnittstelle für das Kundenformular (web/admin). Geschützt mit ADMIN_SECRET im Header
// x-rv-admin-secret (mindestens 32 Zeichen, Vergleich in konstanter Zeit). Nur POST mit JSON.
//
//   {"action": "defaults"}                                  Standardwerte für eine neue Kundin
//   {"action": "list"}                                      alle Kundinnen
//   {"action": "get", "tenant_id": "..."}                   Konfiguration, Status, Schlüssel (ohne Klartext)
//   {"action": "save", "tenant_id": null|"...", "config": {...}}   anlegen oder ändern
//   {"action": "preview", "config": {...}}                  Mails rendern (auch ungespeichert)
//   {"action": "create-key", "tenant_id": "...", "source": "..."}  Integrationsschlüssel, nur einmal sichtbar
//   {"action": "revoke-key", "tenant_id": "...", "integration_id": "..."}
//   {"action": "set-status", "tenant_id": "...", "status": "paused"|"active"}  active nur im Testmodus
//   {"action": "test-mode-on", "tenant_id": "..."}
//   {"action": "go-live", "tenant_id": "...", "confirm_name": "..."}  Testmodus aus, aktiv
//
// Neue Kundinnen sind immer pausiert und im Testmodus. Echter Versand nur über go-live.

import type { Deps } from '../_shared/types.ts';
import { corsHeaders, json, readBody, safeJson, timingSafeEqual } from '../_shared/http.ts';
import { renderRequest } from '../_shared/templates.ts';
import { formatFrom } from '../_shared/resend.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

class BadRequest extends Error {}

const FIELD_LABELS: Record<string, string> = {
  name: 'Kundenname', timezone: 'Zeitzone', location_name: 'Studioname', google_review_url: 'Google-Bewertungslink',
  sender_name: 'Absendername', sender_email: 'Absenderadresse', reply_to_email: 'Antwortadresse',
  report_recipient_email: 'Empfängerin Wochenbericht', send_window: 'Versandfenster',
  greeting_named: 'Anrede mit Vorname', greeting_anonymous: 'Anrede ohne Vorname', signature: 'Grußformel',
  footer_text: 'Fußzeile', unsubscribe_label: 'Abmeldelink-Text', imprint_text: 'Impressum',
  accent_color: 'Buttonfarbe', subject: 'Betreff', body: 'Text', button_label: 'Button-Text',
  closing_note: 'Schlusszeile', initial_delay_minutes: 'Verzögerung Erstmail', reminder_delay_hours: 'Abstand Erinnerung',
  max_sends_per_day: 'Mails pro Tag', stale_after_hours: 'Verfallszeit', retention_days: 'Aufbewahrung',
};

/** Datenbankfehler in eine verständliche Meldung übersetzen. */
export function configError(e: unknown): string | null {
  let msg = (e as Error)?.message ?? '';
  // PostgREST-Fehler kommen als "rpc fn 400: {json}" an, direkte Postgres-Fehler als Klartext.
  const brace = msg.indexOf('{');
  if (brace >= 0) {
    try {
      const j = JSON.parse(msg.slice(brace));
      if (typeof j?.message === 'string') msg = j.message;
    } catch { /* Klartext behalten */ }
  }
  const m = /invalid_config: (.*)/.exec(msg);
  if (!m) return null;
  const detail = m[1].trim();
  const c = /check constraint "(?:tenant_settings|locations|tenants|message_templates)_([a-z_]+?)_check"/.exec(detail);
  if (c) return `Ungültiger Wert: ${FIELD_LABELS[c[1]] ?? c[1]}`;
  if (/check constraint .*tenant_settings_check/.test(detail)) return 'Ungültiger Wert: Versandfenster (Ende muss nach Beginn liegen)';
  if (/time zone/.test(detail)) return 'Ungültiger Wert: Zeitzone';
  if (/invalid input syntax for type time/.test(detail)) return 'Ungültiger Wert: Uhrzeit (Format HH:MM)';
  return detail.slice(0, 200);
}

const SAMPLE = {
  clickUrl: 'https://link.example.invalid/r/?t=beispiel',
  unsubUrl: 'https://link.example.invalid/abmelden/?t=beispiel',
};

async function preview(deps: Deps, config: unknown) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new BadRequest('config fehlt');
  const defaults = await deps.rpc('rv_admin_defaults', {});
  const flat = { ...defaults, ...(config as Record<string, unknown>) };
  const studio = typeof flat.location_name === 'string' && flat.location_name.trim() ? flat.location_name : 'Ihr Studio';
  const out: Record<string, unknown> = {
    from: formatFrom(String(flat.sender_name ?? studio), String(flat.sender_email ?? 'absender@example.invalid')),
    reply_to: flat.reply_to_email ?? null,
  };
  for (const kind of ['initial', 'reminder'] as const) {
    out[kind] = renderRequest(kind, { studio, firstName: 'Anna', ...SAMPLE, config: flat });
    out[`${kind}_ohne_vorname`] = renderRequest(kind, { studio, firstName: null, ...SAMPLE, config: flat }).subject;
  }
  return out;
}

async function act(deps: Deps, b: any) {
  const tid = b.tenant_id;
  const needTenant = () => {
    if (!isUuid(tid)) throw new BadRequest('tenant_id fehlt');
  };
  switch (b.action) {
    case 'defaults':
      return deps.rpc('rv_admin_defaults', {});
    case 'list':
      return { tenants: await deps.rpc('rv_admin_list_tenants', {}) };
    case 'get': {
      needTenant();
      const t = await deps.rpc('rv_admin_get_tenant', { p_tenant_id: tid });
      if (!t) throw new BadRequest('Kundin nicht gefunden');
      return t;
    }
    case 'save': {
      if (tid !== null && tid !== undefined) needTenant();
      if (!b.config || typeof b.config !== 'object' || Array.isArray(b.config)) throw new BadRequest('config fehlt');
      const r = await deps.rpc('rv_admin_save_tenant', { p_tenant_id: tid ?? null, p_config: b.config });
      return { saved: true, ...r };
    }
    case 'preview':
      return preview(deps, b.config);
    case 'create-key': {
      needTenant();
      const t = await deps.rpc('rv_admin_get_tenant', { p_tenant_id: tid });
      if (!t?.location_id) throw new BadRequest('Kundin nicht gefunden');
      const source = typeof b.source === 'string' && b.source.trim() ? b.source.trim().slice(0, 64) : 'eintragsformular';
      const key = await deps.rpc('rv_create_integration', { p_tenant_id: tid, p_location_id: t.location_id, p_source: source });
      return { key, source, hint: 'Schlüssel wird nur jetzt angezeigt. Sicher ablegen.' };
    }
    case 'revoke-key': {
      needTenant();
      if (!isUuid(b.integration_id)) throw new BadRequest('integration_id fehlt');
      return { revoked: await deps.rpc('rv_admin_revoke_integration', { p_tenant_id: tid, p_integration_id: b.integration_id }) };
    }
    case 'set-status': {
      needTenant();
      if (b.status !== 'paused' && b.status !== 'active') throw new BadRequest('status muss paused oder active sein');
      if (b.status === 'active') {
        const t = await deps.rpc('rv_admin_get_tenant', { p_tenant_id: tid });
        if (!t) throw new BadRequest('Kundin nicht gefunden');
        if (!t.test_mode) throw new BadRequest('Aktivieren ohne Testmodus nur über go-live');
      }
      await deps.rpc('rv_set_tenant_status', { p_tenant_id: tid, p_status: b.status });
      return { status: b.status };
    }
    case 'test-mode-on': {
      needTenant();
      await deps.rpc('rv_set_test_mode', { p_tenant_id: tid, p_test_mode: true, p_test_recipients: null });
      return { test_mode: true };
    }
    case 'go-live': {
      needTenant();
      return deps.rpc('rv_admin_go_live', { p_tenant_id: tid, p_confirm_name: String(b.confirm_name ?? '') });
    }
    default:
      throw new BadRequest('unbekannte action');
  }
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req, deps.env, 'content-type, x-rv-admin-secret');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const secret = deps.env.ADMIN_SECRET;
  const given = req.headers.get('x-rv-admin-secret') ?? '';
  if (!secret || secret.length < 32 || !timingSafeEqual(given, secret)) {
    return json({ error: 'unauthorized' }, 401, cors);
  }

  const raw = await readBody(req, 65_536);
  if (raw === null) return json({ error: 'payload_too_large' }, 413, cors);
  const b = safeJson(raw);
  if (!b || typeof b !== 'object') return json({ error: 'invalid_json' }, 400, cors);

  try {
    return json(await act(deps, b), 200, cors);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: 'bad_request', message: e.message }, 400, cors);
    const msg = configError(e);
    if (msg) return json({ error: 'invalid_config', message: msg }, 422, cors);
    deps.log('admin_failed', { action: b.action, error: (e as Error).message });
    return json({ error: 'internal_error' }, 500, cors);
  }
}
