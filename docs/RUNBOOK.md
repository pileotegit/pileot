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
`WORKER_SECRET`, `ADMIN_SECRET`, `OPS_ALERT_EMAIL`, `OPS_SENDER`.

## 4. Statische Seiten

1. In `web/config.js` steht `apiBase: 'https://ayostbgfagrncgfmgyms.supabase.co/functions/v1'` (passt bereits).
2. Ordner `web/` als statisches Projekt auf Vercel veröffentlichen (Root Directory `web`, kein Build).
   Eigene Domain ist optional; die `*.vercel.app`-Adresse reicht.
3. Diese Adresse in `CLICK_PAGE_URL`, `UNSUB_PAGE_URL` und `ALLOWED_ORIGINS` eintragen.
4. Prüfen: `<adresse>/r/` zeigt "Link nicht mehr gültig" (ohne Token korrekt), `<adresse>/admin/` zeigt die Anmeldung.

Seiten:
- `/admin/`: Kundenverwaltung (Passwort = `ADMIN_SECRET`)
- `/eintragen/#k=rvk_...`: Eintragsformular für das Studio (Link erzeugt die Kundenverwaltung)
- `/r/` und `/abmelden/`: Ziel der Links in den Mails

## 5. Resend-Webhook

Resend > Webhooks > Add Endpoint:
- URL: `https://ayostbgfagrncgfmgyms.supabase.co/functions/v1/rv-resend-webhook`
- Events: `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.suppressed`
- Signing Secret kopieren und als `RESEND_WEBHOOK_SECRET` setzen.

## 6. Kundin anlegen (Kundenverwaltung `/admin/`)

1. Anmelden mit `ADMIN_SECRET`.
2. "Neue Kundin": Pflichtfelder (Stern) ausfüllen, Texte anpassen, rechts die Mail live prüfen. Speichern.
   Neue Kundinnen sind immer pausiert und im Testmodus.
3. Testadressen eintragen (nur diese bekommen im Testmodus echte Mails).
4. "Neuen Schlüssel erzeugen": Schlüssel und Link zum Eintragsformular erscheinen genau einmal.
   Den Link bekommt das Studio. Alternativ den Schlüssel in n8n als Credential
   "PILEOT Studio Integration Key" für Workflow A oder in einer Terminsoftware verwenden.
5. Ein verlorener oder weitergegebener Schlüssel wird in der Liste widerrufen, danach neuen erzeugen.

Alles Kundenspezifische (Namen, Adressen, Link, Empfängerin, Versandzeiten, Texte, Impressum, Farbe) liegt in
der Datenbank. Neue Kundin = Formular ausfüllen, kein Code. Platzhalter in Texten: `{{studio}}`, in der
Anrede zusätzlich `{{vorname}}`. Erlaubte Bewertungslinks: nur HTTPS auf `g.page`, `search.google.com`,
`www.google.com`, `maps.app.goo.gl`, `g.co`.

Per SQL geht es weiterhin mit `public.rv_setup_tenant(...)` und `public.rv_admin_save_tenant(null, '{...}')`.

## 7. n8n

1. Credentials anlegen (exakte Namen in `n8n/README.md`).
2. In jedem der fünf Workflows die Credential am HTTP-Knoten auswählen.
3. Workflow A: Formular-URL (Production) der Inhaberin geben, Login aus "PILEOT Studio Formular Login".
4. Workflows veröffentlichen (aktiv schalten). Erst danach laufen die Zeitpläne.

## 8. Testlauf (Testmodus)

1. Kundenverwaltung: "Testbetrieb starten" (aktiv, Testmodus bleibt an).
2. Einmalig global freigeben:
   ```sql
   select public.rv_set_global_send_paused(false);
   ```
3. Im Eintragsformular einen Termin mit einer Testadresse eintragen. Zum Beschleunigen:
   ```sql
   update review.send_jobs set due_at = now() where status = 'queued';
   ```
4. Nach dem nächsten B-Lauf (Viertelstunde) kommt die Mail. Prüfen: Button, Zwischenseite, Weiterleitung zu
   Google, Abmeldung, Wochenbericht-Vorschau:
   ```sql
   select public.rv_weekly_report_preview('<tenant_id>', date_trunc('week', now())::date);
   ```
Eine Nicht-Testadresse erzeugt im Testmodus nur einen `dry_run`, keine Mail.

## 9. Livegang (erst nach geklärter Versandgrundlage)

Kundenverwaltung > Status > "Livegang": Kundennamen eintippen, "Live schalten". Das System verweigert den
Livegang, solange das Impressum fehlt oder noch keine Testmail tatsächlich versendet wurde.
Zurück in den Testmodus: "Testmodus wieder an".

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
