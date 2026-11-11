# ADR 0001: Architektur der Google-Review-Automation V1

Status: angenommen (Entwurf bis zum Review durch Malik)
Datum: 2026-11-11

## Kontext

Eine Kosmetikerin (Pilotkundin, 150 EUR pro Monat) soll nach einem Termin automatisch um eine
Google-Bewertung bitten lassen. Kein Dashboard in V1, Betrieb überwacht. Eine versehentliche
Massenmail, ein doppelter Versand oder ein Verstoß gegen eine Abmeldung wiegen schwerer als
fehlender Funktionsumfang.

## Entscheidungen

1. **Supabase Postgres ist die einzige Wahrheit.** Zustand, Fristen, Sperren und Idempotenz liegen
   in der Datenbank, nicht in n8n. n8n startet nur Schritte und ruft Funktionen auf. Ein
   Neustart von n8n verliert deshalb keinen Zustand.
2. **Tabellen im Schema `review`, nicht über die API erreichbar.** RLS ist überall aktiv, es gibt
   absichtlich keine Policies. `anon`, `authenticated` und `service_role` haben keine Rechte auf
   Tabellen. Zugriff nur über `SECURITY DEFINER`-Funktionen `public.rv_*` mit leerem
   `search_path`, ausführbar nur für `service_role`. Grund: Supabase vergibt für das Schema
   `public` standardmäßig Rechte an `anon` und `authenticated`. Ein Fehler in einer Policy darf
   keine Kundendaten öffnen.
3. **Mandant kommt aus dem API-Key, nie aus dem Request.** Der Key wird nur als SHA-256-Hash
   gespeichert. Zusammengesetzte Fremdschlüssel `(tenant_id, id)` machen mandantenübergreifende
   Verknüpfungen im Schema unmöglich.
4. **Jobs mit Lease statt "senden und hoffen".** Zustände:
   `queued -> claimed -> sending -> sent | failed | unknown`, dazu `cancelled` und `dry_run`.
   - Reservierung atomar mit `FOR UPDATE SKIP LOCKED`.
   - Lease abgelaufen vor `sending`: zurück in die Queue (es wurde nie gesendet).
   - Lease abgelaufen in `sending`: Status `unknown`. **Nie blind erneut senden**, sondern
     gegen den Provider abgleichen (`rv_resolve_unknown_job`). Das ist die Lösung für
     "Absturz nach Providerannahme".
   - Provider-Idempotenzschlüssel `rv-<campaign_id>-<kind>` ist pro Kampagne und Art fest.
5. **Letzte Prüfung direkt vor dem Versand.** `rv_claim_due_jobs` und `rv_mark_job_sending`
   prüfen erneut: globale Pause, Mandant, Standort, Kampagne, Sperrliste, Versandfenster,
   Tageslimit, Testmodus, Alter der Anfrage.
6. **Sichere Standardwerte.** Globaler Versand `paused`, Mandant `paused`, Testmodus an. Ohne
   dokumentierte Versandgrundlage (Einwilligung oder andere dokumentierte Grundlage) wird kein
   Kontakt gespeichert und nichts versendet.
7. **Kein Review-Gating.** Jede Kundin bekommt denselben Link, unabhängig von einer Stimmung.
   Es gibt keinen internen Bewertungsfilter. Das ist eine Plattformregel von Google, kein
   Stilmittel.
8. **Klick-Erfassung trennt Scanner von Menschen.** `raw` (reiner HTTP-Aufruf, auch von
   Mail-Scannern) stoppt nichts und liefert keine URL. Erst `qualified` (bewusster Klick auf
   den Button der Zwischenseite) stoppt die Erinnerung und gibt die Google-URL aus.
   Abmeldung: GET prüft nur, POST wirkt.
9. **Weiterleitungsziele sind eingeschränkt.** `google_review_url` darf nur HTTPS auf wenigen
   Google-Hosts zeigen, ohne Redirect-Pfade. Die Weiterleitung nimmt nie eine URL aus dem Request.
10. **Zeit.** Alles UTC in der Datenbank. Versandfenster und Berichte werden in der Zeitzone des
    Mandanten berechnet (`review.next_send_slot`), damit Sommerzeitwechsel stimmen.
11. **Hosting.** Kein Vercel als Backend. Öffentliche Endpunkte (Aufnahme, Klick, Abmeldung,
    Provider-Webhooks, Arbeitsschritte) sind Supabase Edge Functions und sprechen nur JSON.
    Grund: Supabase liefert auf der Standarddomain `*.supabase.co` seit Oktober 2024 kein HTML aus
    (nur mit dem Custom-Domain-Add-on, 10 USD pro Monat). Die zwei sichtbaren Seiten (Klick-
    Zwischenseite, Abmeldung) sind deshalb statische Dateien im Ordner `web/`, die auf einem
    beliebigen statischen Host liegen können (Empfehlung: Subdomain `link.pileot.de`). Vorteil:
    Links in der Mail zeigen auf die eigene Domain statt auf eine kryptische Supabase-Adresse.
12. **n8n ist nur Auslöser.** Workflows B, D, E, F rufen `rv-jobs` per Zeitplan auf. Workflow A ist
    ein geschütztes Formular für die Inhaberin. Workflow C ist keine n8n-Strecke, sondern die Edge
    Function `rv-resend-webhook`, weil die Svix-Signatur am unveränderten Rohbody geprüft werden muss.
    Takt sparsam wegen des Ausführungskontingents (n8n Starter: 2.500 pro Monat).
13. **Versand mit Idempotenzschlüssel.** Resend speichert `Idempotency-Key` 24 Stunden. Mehrdeutige
    Fehler (Timeout, 5xx, 409 concurrent) werden sofort mit identischem Inhalt wiederholt. Bleibt der
    Ausgang offen, wird der Job `unknown` und nie automatisch erneut gesendet. 401/403 (falscher Key,
    Domain nicht verifiziert) pausieren den Versand global, ohne Versuche zu verbrauchen.
14. **One-Click-Abmeldung nach RFC 8058.** Header `List-Unsubscribe` zeigt auf `rv-unsubscribe`
    (POST wirkt, GET leitet nur auf die Seite um), dazu `List-Unsubscribe-Post`.

## Konsequenzen

- V1-Regel: höchstens eine Kampagne pro Kontakt und Standort. Wiederkehrende Kundinnen
  bekommen in V1 keine zweite Anfrage. Eine Lockerung braucht eine bewusste Regel (z. B. Mindestabstand).
- Alle Fachlogik steckt in SQL. Das ist gut testbar (siehe `tests/db`), aber Änderungen
  brauchen Migrationen und Tests, nicht nur einen Klick in n8n.
- Der Google-Teil hängt an einer manuellen Freigabe (Business Profile API). Bis dahin ist
  der Abgleich der Bewertungen nicht live nutzbar.

## Verworfen

- Zustand in n8n-Variablen oder Data Tables: nicht transaktional, nicht testbar.
- Tabellen im Schema `public` mit RLS-Policies: ein Policy-Fehler wäre ein Datenleck.
- Bewertungsfilter ("nur bei guter Stimmung zu Google"): verstößt gegen Googles Richtlinien.

## 15. Kundenschablone in der Datenbank

Alle kundenspezifischen Angaben (Namen, Adressen, Google-Link, Empfängerin, Versandregeln, Texte, Impressum,
Buttonfarbe) liegen in `tenant_settings` und `message_templates` und werden über `rv-admin` gepflegt. Texte sind
Klartext mit zwei erlaubten Platzhaltern (`{{studio}}`, `{{vorname}}` nur in der Anrede), werden beim Speichern
validiert und beim Rendern immer escaped. Kein HTML von Kundenseite, damit keine Injektion und kein kaputtes
Layout möglich ist. Begründung: eine neue Kundin darf keinen Code und kein Deployment brauchen.

## 16. Livegang nur mit Sperre

`rv_admin_go_live` schaltet Testmodus aus und Mandant aktiv, aber nur mit exakt eingetipptem Kundennamen,
hinterlegtem Impressum und mindestens einer tatsächlich versendeten Testmail. `set-status active` ist ohne
Testmodus gesperrt. Begründung: der riskanteste Schritt (echte Kundinnen) soll nicht versehentlich passieren.

## 17. Eintragsformular statt n8n-Formular pro Kundin

`web/eintragen` ruft `rv-ingest` direkt mit dem Integrationsschlüssel aus dem Linkanker (`#k=`), der nicht an
den Webserver geht. So braucht nicht jede Kundin einen eigenen n8n-Workflow. Restrisiko: der Link steht im
Browserverlauf des Studios; der Schlüssel erlaubt nur das Eintragen für diese Kundin und ist widerrufbar.
Workflow A bleibt als Alternative.
