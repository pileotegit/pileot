// Prüfung der Webhook-Signatur von Resend (Svix-Schema), ohne externe Bibliothek.
// Signierter Inhalt: `${svix-id}.${svix-timestamp}.${rohbody}`, HMAC-SHA256 mit dem
// base64-dekodierten Teil des Secrets nach "whsec_". Header svix-signature enthält eine
// oder mehrere Signaturen "v1,<base64>" getrennt durch Leerzeichen.

import { timingSafeEqual } from './http.ts';

export const TOLERANCE_SECONDS = 5 * 60;

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const keyBytes = b64decode(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return b64encode(mac);
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

export async function verify(
  secret: string,
  headers: Headers,
  body: string,
  now: Date,
): Promise<VerifyResult> {
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature');
  if (!id || !ts || !sigHeader || !/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'missing_headers' };
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const expected = await sign(secret, id, ts, body);
  for (const part of sigHeader.split(' ')) {
    const [version, sig] = part.split(',');
    if (version === 'v1' && sig && timingSafeEqual(sig, expected)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}
