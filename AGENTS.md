# PILEOT Google-Review-Automation V1

Sprache: Deutsch (Du). Antwort zuerst, kurz, keine Gedankenstriche, keine Emojis.

## Harte Regeln

- Nichts live schalten ohne ausdrückliche Freigabe: kein Versand an echte Kundinnen, keine
  Migration auf eine Produktionsdatenbank, kein Veröffentlichen von Workflows.
- Standard ist sicher: globaler Versand pausiert, Mandant pausiert, Testmodus an.
- Kein Review-Gating. Keine erfundenen Zahlen, Quellen oder Rechtsaussagen.
- Mandant immer aus dem API-Key ableiten, nie aus einem Request-Feld.
- Zugriff auf Daten nur über `public.rv_*`-Funktionen. Keine Rechte auf Tabellen im Schema `review` vergeben.
- Jede Änderung an der Logik braucht einen Test in `tests/db`. Danach `npm run test:db`.
- Berichte ehrlich: gebaut / lokal getestet / live geprüft / blockiert (siehe `docs/STATUS.md`).

## Aufbau

- `supabase/migrations`: versionierte SQL-Migrationen (Schema, RPCs)
- `tests/db`: Tests gegen echtes Postgres 16 (`scripts/db-test.sh` startet ein Wegwerf-Cluster)
- `docs/adr`: Architekturentscheidungen
- `supabase/functions`: Edge Functions (Handler mit injizierten Abhängigkeiten, `index.ts` nur Deno-Start)
- `web/`: statische Seiten (Kundenverwaltung, Eintragsformular, Klick, Abmeldung)
- `n8n/`: Workflow-IDs, Credentials, SDK-Quelltexte (n8n ist nur Auslöser)
- `docs/STATUS.md`: Umsetzungsstand, `docs/RUNBOOK.md`: Inbetriebnahme, `docs/KOSTEN.md`

## Befehle

- `npm install` einmalig
- `npm test`: Typprüfung und alle DB- und Function-Tests (startet Postgres 16 auf Unix-Socket)
- `npm run test:e2e`: Browser-Test der statischen Seiten
- `bash scripts/deploy.sh`: Migrationen und Functions auf Supabase (braucht Access Token)
