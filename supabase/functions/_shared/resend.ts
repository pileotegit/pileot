// Versand über die Resend-API mit Idempotenzschlüssel und vorsichtiger Fehlerklassifizierung.
//
// Resend speichert Idempotenzschlüssel 24 Stunden: gleicher Schlüssel und gleicher Inhalt liefert
// die ursprüngliche Antwort ohne erneuten Versand. Deshalb wiederholen wir mehrdeutige Fehler
// (Timeout, Netzwerk, 5xx, 409 concurrent) sofort mit identischem Inhalt. Erst wenn das nicht
// klärt, ob die Mail angenommen wurde, melden wir "unknown_outcome" (nie blind neu senden).

import type { Deps } from './types.ts';

export type Outcome =
  | { outcome: 'sent'; id: string }
  | { outcome: 'transient_error'; detail: string }
  | { outcome: 'permanent_error'; detail: string }
  | { outcome: 'unknown_outcome'; detail: string }
  | { outcome: 'config_error'; detail: string };

export type Mail = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
};

const API = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;
const INLINE_RETRIES = 2;

export function formatFrom(name: string, email: string): string {
  const n = name.replace(/["\\\r\n<>]/g, '').trim();
  return `"${n}" <${email}>`;
}

export async function sendMail(deps: Deps, mail: Mail, idempotencyKey: string): Promise<Outcome> {
  if (!deps.env.RESEND_API_KEY) return { outcome: 'config_error', detail: 'RESEND_API_KEY fehlt' };
  const body = JSON.stringify({
    from: mail.from,
    to: [mail.to],
    reply_to: mail.replyTo ? [mail.replyTo] : undefined,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: mail.headers,
    tags: mail.tags,
  });

  let last: Outcome = { outcome: 'unknown_outcome', detail: 'kein Versuch' };
  for (let attempt = 0; attempt <= INLINE_RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(attempt * 1500);
    let res: Response;
    try {
      res = await deps.fetch(API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      last = { outcome: 'unknown_outcome', detail: `Netzwerk/Timeout: ${(e as Error).name}` };
      continue;
    }

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const name = typeof data?.name === 'string' ? data.name : '';

    if (res.ok && typeof data?.id === 'string') return { outcome: 'sent', id: data.id };
    if (res.ok) {
      last = { outcome: 'unknown_outcome', detail: 'Antwort ohne id' };
      continue;
    }
    if (res.status === 409 && name === 'concurrent_idempotent_requests') {
      last = { outcome: 'unknown_outcome', detail: '409 concurrent' };
      continue;
    }
    if (res.status === 409) {
      // Gleicher Schlüssel, anderer Inhalt: ein früherer Versuch wurde angenommen.
      return { outcome: 'unknown_outcome', detail: `409 ${name}` };
    }
    if (res.status === 429) return { outcome: 'transient_error', detail: '429 rate limit' };
    if (res.status === 401 || res.status === 403) return { outcome: 'config_error', detail: `${res.status} ${name}` };
    if (res.status >= 500) {
      last = { outcome: 'unknown_outcome', detail: `${res.status}` };
      continue;
    }
    return { outcome: 'permanent_error', detail: `${res.status} ${name}` };
  }
  return last;
}
