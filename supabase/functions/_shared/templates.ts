// Deutsche E-Mail-Vorlagen, Version v1. Keine Bewertungsfilterung: jede Empfängerin bekommt
// denselben Link zu Google. Formulierungen bitten um eine ehrliche Bewertung, ohne Anreiz.

export type MailContent = { subject: string; html: string; text: string };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Header-Injection und Steuerzeichen aus Freitext entfernen. */
export const clean = (s: string | null | undefined, max = 80) =>
  (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function greeting(firstName: string | null | undefined): string {
  const n = clean(firstName, 40);
  return n ? `Hallo ${n},` : 'Hallo,';
}

function layout(studio: string, bodyHtml: string, unsubUrl: string): string {
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
Sie erhalten diese Nachricht im Zusammenhang mit Ihrem Termin bei ${esc(studio)}.
<a href="${esc(unsubUrl)}" style="color:#777;">Keine weiteren E-Mails dieser Art erhalten</a>.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;"><tr>
<td style="background:#1f2937;border-radius:6px;"><a href="${esc(url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:bold;">${esc(label)}</a></td>
</tr></table>`;
}

export function renderRequest(
  kind: 'initial' | 'reminder',
  p: { studio: string; firstName?: string | null; clickUrl: string; unsubUrl: string },
): MailContent {
  const studio = clean(p.studio, 100);
  const hello = greeting(p.firstName);

  if (kind === 'initial') {
    const subject = `Wie war Ihr Termin bei ${studio}?`;
    const lines = [
      `vielen Dank für Ihren Besuch bei ${studio}.`,
      'Wenn Sie einen Moment Zeit haben, freuen wir uns über Ihre ehrliche Bewertung bei Google. Sie hilft anderen bei der Entscheidung und uns, besser zu werden.',
    ];
    const html = layout(
      studio,
      `<p style="margin:0 0 14px 0;">${esc(hello)}</p>
<p style="margin:0 0 14px 0;">${esc(lines[0])}</p>
<p style="margin:0 0 14px 0;">${esc(lines[1])}</p>
${button(p.clickUrl, 'Bewertung bei Google schreiben')}
<p style="margin:0 0 4px 0;">Herzliche Grüße</p>
<p style="margin:0;">${esc(studio)}</p>`,
      p.unsubUrl,
    );
    const text = `${hello}

${lines[0]}

${lines[1]}

Bewertung bei Google schreiben:
${p.clickUrl}

Herzliche Grüße
${studio}

--
Sie erhalten diese Nachricht im Zusammenhang mit Ihrem Termin bei ${studio}.
Keine weiteren E-Mails dieser Art erhalten: ${p.unsubUrl}
`;
    return { subject, html, text };
  }

  const subject = `Kurze Erinnerung: Ihre Meinung zu ${studio}`;
  const lines = [
    `vor ein paar Tagen waren Sie bei ${studio}. Falls Sie es noch nicht geschafft haben: Wir freuen uns weiterhin über Ihre ehrliche Bewertung bei Google.`,
    'Das ist unsere letzte Nachricht dazu.',
  ];
  const html = layout(
    studio,
    `<p style="margin:0 0 14px 0;">${esc(hello)}</p>
<p style="margin:0 0 14px 0;">${esc(lines[0])}</p>
${button(p.clickUrl, 'Bewertung bei Google schreiben')}
<p style="margin:0 0 14px 0;">${esc(lines[1])}</p>
<p style="margin:0 0 4px 0;">Herzliche Grüße</p>
<p style="margin:0;">${esc(studio)}</p>`,
    p.unsubUrl,
  );
  const text = `${hello}

${lines[0]}

Bewertung bei Google schreiben:
${p.clickUrl}

${lines[1]}

Herzliche Grüße
${studio}

--
Sie erhalten diese Nachricht im Zusammenhang mit Ihrem Termin bei ${studio}.
Keine weiteren E-Mails dieser Art erhalten: ${p.unsubUrl}
`;
  return { subject, html, text };
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
