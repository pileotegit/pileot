# PILEOT Google-Review-Automation V1

Bittet Kundinnen nach einem abgeschlossenen Termin per E-Mail um eine ehrliche Google-Bewertung:
eine Anfrage, höchstens eine Erinnerung nach 48 Stunden, Abmeldung jederzeit. Wöchentlicher
Bericht an die Inhaberin. Kein Dashboard, kein Bewertungsfilter.

## Ablauf

```
Inhaberin (n8n-Formular A) oder Terminsoftware
        │  POST rv-ingest (API-Key pro Mandant)
        ▼
Postgres (Schema review): Kontakt, Kampagne, Versandauftrag (fällig nach 2 h, im Versandfenster)
        ▲                                  │
        │ n8n B alle 15 Min: rv-jobs send  │ Resend (Idempotency-Key, List-Unsubscribe)
        │                                  ▼
        │                         E-Mail an die Kundin
        │                           │ Button            │ Abmelden
        │                           ▼                   ▼
        │                 link.pileot.de/r/      link.pileot.de/abmelden/  (statische Seiten)
        │                           │ rv-click           │ rv-unsubscribe
        └─────── Resend-Webhooks (rv-resend-webhook): zugestellt, Bounce, Beschwerde
n8n D: Google-Abgleich · n8n E: Wochenbericht · n8n F: Betriebsprüfung und Löschfristen
```

## Aufbau

| Pfad | Inhalt |
|---|---|
| `supabase/migrations/` | Schema, Sicherheit, alle Fachfunktionen (`public.rv_*`) |
| `supabase/functions/` | Edge Functions `rv-ingest`, `rv-jobs`, `rv-click`, `rv-unsubscribe`, `rv-resend-webhook` |
| `supabase/functions/_shared/templates.ts` | Deutsche E-Mail-Vorlagen v1 (HTML und Text) |
| `web/` | Statische Seiten für Klick und Abmeldung |
| `n8n/` | Workflow-Übersicht, Credentials, SDK-Quelltexte |
| `tests/` | DB-Tests, Function-Tests, Browser-Test (alles synthetische Daten) |
| `docs/` | ADR, Runbook, Kosten, Status |

## Tests

```
npm install
npm test          # Typprüfung, 52 DB- und Function-Tests gegen echtes Postgres 16
npm run test:e2e  # Browser-Test der Seiten (Chrome + Python-Playwright)
```

`scripts/db-test.sh` startet ein Wegwerf-Postgres auf einem Unix-Socket (Standard
`/usr/lib/postgresql/16/bin`, anpassbar über `PGBIN`).

## Inbetriebnahme

Schritt für Schritt in [`docs/RUNBOOK.md`](docs/RUNBOOK.md). Stand der Umsetzung in
[`docs/STATUS.md`](docs/STATUS.md), Kosten in [`docs/KOSTEN.md`](docs/KOSTEN.md).

## Sicherheitsprinzipien (Kurzfassung)

- Neue Mandanten sind pausiert und im Testmodus, der globale Versand ist pausiert.
- Ohne dokumentierte Versandgrundlage wird nichts gespeichert und nichts versendet.
- Tabellen sind über die API nicht erreichbar, Zugriff nur über `rv_*`-Funktionen mit `service_role`.
- Mandant ergibt sich aus dem API-Key, nie aus Request-Daten.
- Tokens, API-Keys und Sperr-Adressen liegen nur als SHA-256-Hash vor.
- Kein Doppelversand: Lease, Idempotenzschlüssel, Status `unknown` statt Blindwiederholung.
