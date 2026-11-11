// Nur für die Laufzeit in Supabase Edge Functions (Deno). Tests nutzen eigene Deps.
import type { Deps, Env, Rpc } from './types.ts';

declare const Deno: { env: { get(name: string): string | undefined } };

function must(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}

/** RPC über PostgREST mit dem Service-Role-Key. Die Funktionen liegen im Schema public. */
export function postgrestRpc(url: string, key: string): Rpc {
  return async (fn, args = {}) => {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(20_000),
    });
    const textBody = await res.text();
    if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${textBody.slice(0, 1000)}`);
    return textBody ? JSON.parse(textBody) : null;
  };
}

export function denoDeps(): Deps {
  const supabaseUrl = must('SUPABASE_URL');
  const env: Env = {
    FUNCTIONS_BASE_URL: Deno.env.get('FUNCTIONS_BASE_URL') ?? `${supabaseUrl}/functions/v1`,
    CLICK_PAGE_URL: must('CLICK_PAGE_URL'),
    UNSUB_PAGE_URL: must('UNSUB_PAGE_URL'),
    ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') ?? '',
    RESEND_API_KEY: Deno.env.get('RESEND_API_KEY'),
    RESEND_WEBHOOK_SECRET: Deno.env.get('RESEND_WEBHOOK_SECRET'),
    WORKER_SECRET: Deno.env.get('WORKER_SECRET'),
    ADMIN_SECRET: Deno.env.get('ADMIN_SECRET'),
    OPS_ALERT_EMAIL: Deno.env.get('OPS_ALERT_EMAIL'),
    OPS_SENDER: Deno.env.get('OPS_SENDER'),
    GOOGLE_CLIENT_ID: Deno.env.get('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: Deno.env.get('GOOGLE_CLIENT_SECRET'),
    GOOGLE_REFRESH_TOKEN: Deno.env.get('GOOGLE_REFRESH_TOKEN'),
  };
  return {
    rpc: postgrestRpc(supabaseUrl, must('SUPABASE_SERVICE_ROLE_KEY')),
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Keine personenbezogenen Daten loggen: nur Codes und IDs.
    log: (msg, data) => console.log(JSON.stringify({ msg, ...data })),
  };
}
