import type { Env } from './types.ts';

const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

export function text(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...extra },
  });
}

export function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, location } });
}

/** CORS nur für die konfigurierten Origins der statischen Seiten. */
export function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

/** Liest den Body mit Größenlimit. Liefert null, wenn zu groß. */
export async function readBody(req: Request, maxBytes = 16_384): Promise<string | null> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > maxBytes) return null;
  return new TextDecoder().decode(buf);
}

export function safeJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Vergleich in konstanter Zeit (gegen Timing-Angriffe auf Secrets). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;
export function isToken(t: unknown): t is string {
  return typeof t === 'string' && TOKEN_RE.test(t);
}
