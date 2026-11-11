# Runbook: Inbetriebnahme und Betrieb

Alle SQL-Befehle im Supabase SQL Editor des Projekts `ayostbgfagrncgfmgyms` ausführen
(dort läuft man als `postgres`, die `rv_*`-Funktionen sind aufrufbar).

## 1. Voraussetzungen

| Was | Exakter Wert |
|---|---|
| Resend-Domain | `mail.pileot.de`, Region EU (Frankfurt), SPF, DKIM und Return-Path laut Resend beim DNS-Anbieter eintragen, Status `Verified` |
| Resend API-Key | Permission `Sending access`, Domain `mail.pileot.de` |
| Linkdomain | Subdomain `link.pileot.de` auf einem statischen Host, Inhalt = Ordner `web/` |
| WORKER_SECRET | `openssl rand -hex 32` (64 Zeichen) |

## 2. Datenbank und Functions deployen

```
export SUPABASE_ACCESS_TOKEN=...      # Account > Access Tokens
export SUPABASE_DB_PASSWORD=...       # Project Settings > Database
bash scripts/deploy.sh
```

Danach prüfen: Dashboard > Database > Schemas: `review` existiert. API > Exposed schemas: nur `public` (nicht `review`).

## 3. Secrets setzen

Dashboard > Edge Functions > Secrets (oder `supabase secrets set NAME=wert`). Werte siehe `.env.example`:
`CLICK_PAGE_URL`, `UNSUB_PAGE_URL`, `ALLOWED_ORIGINS`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`,
`WORKER_SECRET`, `OPS_ALERT_EMAIL`, `OPS_SENDER`.

## 4. Statische Seiten

1. In `web/config.js` steht `apiBase: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1'` (passt bereits).
2. Ordner `web/` auf `link.pileot.de` veröffentlichen (HTTPS Pflicht).
3. Prüfen: `https://link.pileot.de/r/` zeigt "Link nicht mehr gültig" (ohne Token korrekt).

## 5. Resend-Webhook

Resend > Webhooks > Add Endpoint:
- URL: `https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-resend-webhook`
- Events: `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.suppressed`
- Signing Secret kopieren und als `RESEND_WEBHOOK_SECRET` setzen.

## 6. Mandant anlegen (sicher voreingestellt: pausiert, Testmodus)

```sql
select public.rv_setup_tenant(
  'Studio Name',                       -- Mandant
  'Studio Name',                       -- Standort (erscheint in Mail und Seite)
  'https://g.page/r/XXXX/review',      -- Google-Bewertungslink aus dem Unternehmensprofil
  'Studio Name',                       -- Absendername
  'studio-name@mail.pileot.de',        -- Absenderadresse (verifizierte Domain)
  'inhaberin@studio.de',               -- Antworten gehen an die Inhaberin
  'inhaberin@studio.de',               -- Empfängerin Wochenbericht
  'Europe/Berlin',
  array['test1@...', 'test2@...']      -- Testadressen
);
-- liefert tenant_id und location_id

select public.rv_create_integration('<tenant_id>', '<location_id>', 'studio-formular');
-- liefert rvk_... genau einmal. In n8n als Credential "PILEOT Studio Integration Key"
-- (Header Auth, Name Authorization, Value "Bearer rvk_...") speichern. Nirgends sonst ablegen.
```

Erlaubte Bewertungslinks: nur HTTPS auf `g.page`, `search.google.com`, `www.google.com`, `maps.app.goo.gl`, `g.co`.

## 7. n8n

1. Credentials anlegen (exakte Namen in `n8n/README.md`).
2. In jedem der fünf Workflows die Credential am HTTP-Knoten auswählen.
3. Workflow A: Formular-URL (Production) der Inhaberin geben, Login aus "PILEOT Studio Formular Login".
4. Workflows veröffentlichen (aktiv schalten). Erst danach laufen die Zeitpläne.

## 8. Testlauf (Testmodus)

```sql
select public.rv_set_tenant_status('<tenant_id>', 'active');
select public.rv_set_global_send_paused(false);
```
Über das Formular einen Termin mit einer Testadresse eintragen. Zum Beschleunigen:
```sql
update review.send_jobs set due_at = now() where status = 'queued';
```
Nach dem nächsten B-Lauf (Viertelstunde) kommt die Mail. Prüfen: Button, Zwischenseite, Weiterleitung zu
Google, Abmeldung, Wochenbericht-Vorschau:
```sql
select public.rv_weekly_report_preview('<tenant_id>', date_trunc('week', now())::date);
```
Eine Nicht-Testadresse im Formular erzeugt im Testmodus nur einen `dry_run`, keine Mail.

## 9. Livegang (erst nach geklärter Versandgrundlage)

```sql
select public.rv_set_test_mode('<tenant_id>', false);
```

## Betrieb

| Situation | Handlung |
|---|---|
| Sofort alles stoppen | `select public.rv_set_global_send_paused(true);` |
| Nur ein Studio stoppen | `select public.rv_set_tenant_status('<tenant_id>', 'paused');` |
| Kundin will per Telefon keine Mails | `select public.rv_suppress_manual('<tenant_id>', 'kundin@...');` |
| Warnung `unknown_jobs` | Resend > Emails nach Empfängerin suchen. Gesendet: `select public.rv_resolve_unknown_job('<job_id>', 'sent', '<resend-id>');` Nicht gesendet: `... 'not_sent')` |
| Warnung `auto_paused` | API-Key und Domain in Resend prüfen, dann `rv_set_global_send_paused(false)` |
| Warnung `complaints_7d` | Versand pausieren, Versandgrundlage mit der Inhaberin klären |
| Warnung `overdue_jobs` | Läuft Workflow B? Ausführungen in n8n ansehen, Secret prüfen |
| Status ansehen | `select public.rv_ops_health();` |
| Unklare Jobs finden | `select id, campaign_id, kind, updated_at from review.send_jobs where status = 'unknown';` |

## Google-Abgleich aktivieren (nach Freigabe durch Google)

1. Google Cloud: OAuth-Client (Typ Web), Scope `https://www.googleapis.com/auth/business.manage`.
2. Refresh-Token mit einem Konto erzeugen, das Inhaber oder Manager des Profils ist.
3. Secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` setzen.
4. Location-Name ermitteln (`accounts/<id>/locations/<id>`) und hinterlegen:
   `select public.rv_set_google_location('<location_id>', 'accounts/123/locations/456');`
5. Workflow D manuell ausführen und Ergebnis prüfen.
