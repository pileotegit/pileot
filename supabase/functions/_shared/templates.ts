// E-Mail-Vorlagen. Texte kommen pro Kundin aus der Datenbank (Kundenschablone), Layout und
// Sicherheit (Escaping, keine Header-Injection, ein Link für alle) liegen hier.

export type MailContent = { subject: string; html: string; text: string };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Header-Injection und Steuerzeichen aus Freitext entfernen. */
export const clean = (s: string | null | undefined, max = 80) =>
  (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Flache Kundenkonfiguration (review.tenant_config bzw. rv_admin_defaults). */
export type FlatConfig = Record<string, any>;

export type MailConfig = {
  greeting_named: string;
  greeting_anonymous: string;
  signature: string;
  footer_text: string;
  unsubscribe_label: string;
  imprint_text: string;
  accent_color: string;
  subject: string;
  body: string;
  button_label: string;
  closing_note: string;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function mailConfig(flat: FlatConfig, kind: 'initial' | 'reminder'): MailConfig {
  return {
    greeting_named: str(flat.greeting_named),
    greeting_anonymous: str(flat.greeting_anonymous),
    signature: str(flat.signature),
    footer_text: str(flat.footer_text),
    unsubscribe_label: str(flat.unsubscribe_label),
    imprint_text: str(flat.imprint_text),
    accent_color: str(flat.accent_color),
    subject: str(flat[`${kind}_subject`]),
    body: str(flat[`${kind}_body`]),
    button_label: str(flat[`${kind}_button`]),
    closing_note: str(flat[`${kind}_closing`]),
  };
}

const PLACEHOLDER = /\{\{\s*(studio|vorname)\s*\}\}/g;

/** Platzhalter ersetzen. Unbekannte Platzhalter lehnt die Datenbank beim Speichern ab. */
export function fill(s: string, vars: { studio: string; vorname?: string }): string {
  return s.replace(PLACEHOLDER, (_m, k: 'studio' | 'vorname') => vars[k] ?? '');
}

const normLines = (s: string) => s.replace(/\r\n?/g, '\n').trim();
const paragraphs = (s: string) => normLines(s).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const htmlLines = (s: string) => esc(normLines(s)).replace(/\n/g, '<br>');

function safeColor(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#1f2937';
}

/** Weiß oder Dunkel als Schriftfarbe, je nach Helligkeit der Buttonfarbe. */
function onColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111111' : '#ffffff';
}

function layout(studio: string, bodyHtml: string, footerHtml: string): string {
  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(studio)}</title></head>
<body style="margin:0;padding:0;background:#f6f5f3;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f5f3;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:8px;">
<tr><td style="padding:28px 28px 8px 28px;font-size:16px;line-height:1.55;">
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px 28px 28px;font-size:12px;line-height:1.5;color:#777;border-top:1px solid #eee;">
${footerHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(url: string, label: string, color: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;"><tr>
<td style="background:${color};border-radius:6px;"><a href="${esc(url)}" style="display:inline-block;padding:12px 22px;color:${onColor(color)};text-decoration:none;font-weight:bold;">${esc(label)}</a></td>
</tr></table>`;
}

/**
 * Bewertungsanfrage oder Erinnerung aus der Kundenkonfiguration. Jede Empfängerin bekommt
 * denselben Google-Link (kein Review-Gating). Alle Texte werden escaped.
 */
export function renderRequest(
  kind: 'initial' | 'reminder',
  p: { studio: string; firstName?: string | null; clickUrl: string; unsubUrl: string; config: FlatConfig },
): MailContent {
  const c = mailConfig(p.config, kind);
  const studio = clean(p.studio, 100);
  const firstName = clean(p.firstName, 40);
  const vars = { studio, vorname: firstName };
  const f = (s: string) => fill(s, vars);

  const hello = clean(firstName ? f(c.greeting_named) : f(c.greeting_anonymous), 120) || 'Hallo,';
  const subject = clean(f(c.subject), 150);
  const body = paragraphs(f(c.body));
  const closing = paragraphs(f(c.closing_note));
  const signature = normLines(f(c.signature));
  const footer = clean(f(c.footer_text), 300);
  const unsubLabel = clean(f(c.unsubscribe_label), 100) || 'Abmelden';
  const imprint = normLines(f(c.imprint_text));
  const buttonLabel = clean(f(c.button_label), 60) || 'Bewertung schreiben';
  const color = safeColor(c.accent_color);

  const P = (inner: string) => `<p style="margin:0 0 14px 0;">${inner}</p>`;
  const bodyHtml = [
    P(esc(hello)),
    ...body.map((x) => P(htmlLines(x))),
    button(p.clickUrl, buttonLabel, color),
    ...closing.map((x) => P(htmlLines(x))),
    `<p style="margin:0;">${htmlLines(signature)}</p>`,
  ].join('\n');
  const footerHtml = `${esc(footer)}
<a href="${esc(p.unsubUrl)}" style="color:#777;">${esc(unsubLabel)}</a>.${
    imprint ? `\n<br><br><span style="color:#999;">${htmlLines(imprint)}</span>` : ''
  }`;

  const text = [
    hello,
    ...body,
    `${buttonLabel}:\n${p.clickUrl}`,
    ...closing,
    signature,
    `--\n${footer}\n${unsubLabel}: ${p.unsubUrl}${imprint ? `\n\n${imprint}` : ''}`,
  ].join('\n\n') + '\n';

  return { subject, html: layout(studio, bodyHtml, footerHtml), text };
}

const fmtDate = (d: string) => {
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
};

/** Wochenbericht an die Inhaberin. Nur gemessene Zahlen, keine Zuordnung von Bewertungen zu E-Mails. */
export function renderWeeklyReport(tenantName: string, r: any): MailContent {
  const studio = clean(tenantName, 100);
  const period = `${fmtDate(r.week_start)} bis ${fmtDate(r.week_end)}`;
  const rows: [string, string][] = [
    ['Abgeschlossene Termine erfasst', String(r.completions)],
    ['Bewertungsanfragen versendet', String(r.initial_sent)],
    ['Erinnerungen versendet', String(r.reminders_sent)],
    ['Zugestellt (laut E-Mail-Dienst)', String(r.delivered)],
    ['Klicks auf "Bewertung schreiben"', String(r.qualified_clicks)],
    ['Abmeldungen', String(r.unsubscribes)],
    ['Unzustellbar', String(r.bounced)],
    ['Spam-Meldungen', String(r.complaints)],
  ];
  const notes: string[] = [];
  if (r.google?.enabled) {
    rows.push(['Neue Google-Bewertungen', String(r.google.new_reviews)]);
    if (r.google.avg_rating_new !== null && r.google.avg_rating_new !== undefined) {
      rows.push(['Durchschnitt neuer Bewertungen', String(r.google.avg_rating_new).replace('.', ',') + ' Sterne']);
    }
    rows.push(['Google-Bewertungen gesamt (erfasst)', String(r.google.total_reviews)]);
  } else {
    notes.push('Der Abgleich mit Google ist noch nicht aktiv. Neue Bewertungen sehen Sie direkt in Ihrem Google-Unternehmensprofil.');
  }
  notes.push('Klicks zeigen, wie viele Kundinnen die Bewertungsseite geöffnet haben. Ob und wie sie bewertet haben, entscheidet jede Kundin selbst; eine einzelne Bewertung lässt sich keiner E-Mail zuordnen.');
  if (r.test_mode) notes.unshift('Testmodus ist aktiv: Es wurden nur Testadressen angeschrieben.');
  if (r.tenant_status !== 'active') notes.unshift('Der Versand ist derzeit pausiert.');
  if (r.failed > 0 || r.open_unknown > 0) notes.push('Es gab technische Auffälligkeiten beim Versand. PILEOT prüft das.');

  const subject = `Wochenbericht Google-Bewertungen, ${period}`;
  const tableRows = rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">${esc(v)}</td></tr>`)
    .join('\n');
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#222;background:#f6f5f3;margin:0;padding:24px 12px;">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;"><tr><td style="padding:28px;font-size:15px;line-height:1.5;">
<p style="margin:0 0 12px 0;">Hallo,</p>
<p style="margin:0 0 16px 0;">hier ist der Wochenbericht für ${esc(studio)} (${esc(period)}).</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:15px;">
${tableRows}
</table>
${notes.map((n) => `<p style="margin:14px 0 0 0;font-size:13px;color:#555;">${esc(n)}</p>`).join('\n')}
<p style="margin:20px 0 0 0;">Viele Grüße<br>PILEOT</p>
</td></tr></table></body></html>`;
  const text = `Hallo,

hier ist der Wochenbericht für ${studio} (${period}).

${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}

${notes.join('\n\n')}

Viele Grüße
PILEOT
`;
  return { subject, html, text };
}

export function renderOpsAlert(health: any): MailContent {
  const subject = `[PILEOT Review] ${health.alerts.length} Warnung(en)`;
  const lines = health.alerts.map((a: any) => `- ${a.code} (${a.count}): ${a.hint}`);
  const text = `Betriebsprüfung ${health.checked_at}

${lines.join('\n')}

Globaler Versand pausiert: ${health.send_paused ? 'ja' : 'nein'}${health.pause_reason ? ` (${health.pause_reason})` : ''}
`;
  const html = `<pre style="font-family:monospace;font-size:13px;">${esc(text)}</pre>`;
  return { subject, html, text };
}
