// Test-Abhängigkeiten für die Edge-Function-Handler: echtes Postgres (wie PostgREST aufgerufen),
// gefälschte Provider (Resend, Google) mit Aufzeichnung.

const SETOF = new Set(['rv_claim_due_jobs', 'rv_list_google_locations', 'rv_claim_weekly_reports']);

/** Ruft eine public.rv_*-Funktion wie PostgREST mit benannten Argumenten auf. */
export function pgRpc(client) {
  return async (fn, args = {}) => {
    if (!/^rv_[a-z_]+$/.test(fn)) throw new Error('bad fn');
    const names = Object.keys(args);
    const values = names.map((n) => {
      const v = args[n];
      if (v !== null && typeof v === 'object' && !(Array.isArray(v) && v.every((x) => typeof x !== 'object'))) return JSON.stringify(v);
      return v;
    });
    const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
    if (SETOF.has(fn)) {
      const r = await client.query(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as r from ${call} x`, values);
      return r.rows[0].r;
    }
    const r = await client.query(`select to_jsonb(${call}) as r`, values);
    return r.rows[0].r;
  };
}

export const ENV = {
  FUNCTIONS_BASE_URL: 'https://ref.supabase.co/functions/v1',
  CLICK_PAGE_URL: 'https://link.example.test/r/',
  UNSUB_PAGE_URL: 'https://link.example.test/abmelden/',
  ALLOWED_ORIGINS: 'https://link.example.test',
  RESEND_API_KEY: 're_test_key',
  RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.from('test-webhook-secret-0123456789abcdef').toString('base64'),
  WORKER_SECRET: 'w'.repeat(40),
  OPS_ALERT_EMAIL: 'ops@example.test',
  OPS_SENDER: '"PILEOT System" <system@mail.example.test>',
};

/**
 * Fake-Resend: Idempotenz wie dokumentiert (gleicher Schlüssel + gleicher Inhalt -> gleiche Antwort,
 * anderer Inhalt -> 409). `script` steuert Fehler pro Aufruf: Funktion (call) => 'ok' | 'timeout' | status.
 */
export function fakeResend(script = () => 'ok') {
  const sent = [];
  const keys = new Map();
  let calls = 0;
  let accepted = 0;
  const fetch = async (url, init) => {
    if (url !== 'https://api.resend.com/emails') throw new Error('unexpected url ' + url);
    calls++;
    const action = script(calls, init);
    const key = init.headers['idempotency-key'];
    const body = init.body;
    if (action === 'timeout-after-accept' || action === 'ok') {
      let id;
      if (keys.has(key)) {
        const prev = keys.get(key);
        if (prev.body !== body) return new Response(JSON.stringify({ name: 'invalid_idempotent_request' }), { status: 409 });
        id = prev.id;
      } else {
        id = 'msg_' + (++accepted);
        keys.set(key, { body, id });
        sent.push({ key, ...JSON.parse(body), id });
      }
      if (action === 'timeout-after-accept') {
        const e = new Error('timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (action === 'timeout') {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    return new Response(JSON.stringify({ name: 'error' }), { status: action });
  };
  return { fetch, sent, get calls() { return calls; } };
}

export function makeDeps(client, { fetch, env = {}, now } = {}) {
  const logs = [];
  return {
    deps: {
      rpc: pgRpc(client),
      env: { ...ENV, ...env },
      fetch: fetch ?? (async () => { throw new Error('no network in tests'); }),
      now: now ?? (() => new Date()),
      sleep: async () => {},
      log: (msg, data) => logs.push({ msg, ...data }),
    },
    logs,
  };
}

export const jsonReq = (url, body, headers = {}) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
