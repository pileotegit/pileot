# Status Google-Review-Automation V1

Stand: 2026-11-11. Nichts wird hier schöner dargestellt als es ist.

**gebaut** = Code liegt vor. **lokal getestet** = automatische Tests gegen echtes Postgres 16 und
die echten Handler (Provider simuliert). **live** = in Supabase/Resend/Google geprüft.

## Übersicht

| Teil | gebaut | lokal getestet | live | Blocker |
|---|---|---|---|---|
| Datenmodell, RLS, Rechte (3 Migrationen) | ja | ja | nein | Supabase-Zugriff |
| Abschluss aufnehmen (`rv-ingest`, Workflow A) | ja | ja | nein | Supabase, n8n-Credentials |
| Versand (`rv-jobs send`, Workflow B, Vorlagen v1) | ja | ja (Resend simuliert) | nein | Resend-Domain, Supabase |
| Provider-Webhooks (`rv-resend-webhook`) | ja | ja (Svix-Signatur echt berechnet) | nein | Resend-Webhook |
| Klick und Abmeldung (Functions + `web/`) | ja | ja, auch im Browser (Chrome) | nein | Linkdomain |
| Erinnerung nach 48 h | ja | ja | nein | |
| Google-Abgleich (`rv-jobs google-sync`, Workflow D) | ja | ja (Fixtures) | nein | Google-API-Freigabe |
| Wochenbericht (Workflow E) | ja | ja | nein | |
| Betrieb, Warnmail, Löschfristen (Workflow F) | ja | ja | nein | |
| n8n Workflows A, B, D, E, F | ja, als Entwürfe | Struktur validiert, nicht ausgeführt | nein | Credentials, Aktivierung |

Tests: `npm test` = Typprüfung + 52 Tests, `npm run test:e2e` = Browser-Test. Alle grün.
Zusätzlich Mutationstest am SQL: absichtlich eingebaute Fehler werden von den Tests erkannt.

## Abnahmekriterien (Masterprompt Abschnitt 12)

| Kriterium | Nachweis |
|---|---|
| Doppelte Abschlussereignisse erzeugen keine Doppelkampagne | 10 parallele Aufrufe, `tests/db/review.test.mjs` |
| Parallele Worker versenden nicht doppelt | 8 parallele Claims, `SKIP LOCKED` |
| Absturz nach Providerannahme führt nicht zu Doppelversand | Status `unknown` ohne Blindwiederholung; Timeout nach Annahme wird über denselben Idempotenzschlüssel aufgelöst (`tests/functions`) |
| Genau eine Erinnerung nach 48 h | Fälligkeit geprüft, keine dritte Mail, doppelte Erfolgsmeldung erzeugt keine zweite |
| Stopps (Abmeldung, Bounce, Beschwerde, Pausen) | DB- und Function-Tests, auch Abmeldung zwischen Reservierung und Versand |
| Scanner vs. bewusster Klick | `raw` stoppt nichts, nur Button (`qualified`) stoppt; Browser-Test |
| Mandantentrennung | zwei Mandanten, gleiche Adresse, getrennte Sperren, Fremdschlüssel verhindern Querverweise |
| Gefälschte Webhooks | veränderter Body, fehlende Signatur, alter Zeitstempel: 401 |
| Google-Abgleich idempotent | Wiederholung ändert nichts, nur geänderte Einträge werden aktualisiert |
| Bericht korrekt über Zeitumstellung | Wochen mit 167 und 169 Stunden geprüft |
| Sicher voreingestellt | neue Mandanten pausiert und im Testmodus, globaler Versand pausiert |

## Bewusste Abweichungen vom Masterprompt

- Workflow C läuft nicht in n8n, sondern als Edge Function (Signaturprüfung am Rohbody).
- Klick- und Abmeldeseite sind statisch (`web/`), weil Supabase auf `*.supabase.co` kein HTML ausliefert.
- n8n-Takt 15 Minuten im Versandfenster statt 5 Minuten, wegen des Ausführungskontingents.
- Formularangaben werden nicht zusätzlich in n8n gespeichert (Datensparsamkeit); die Datenbank ist die Ablage.

## Was ich nicht selbst erledigen konnte

1. **Supabase-Zugriff:** Tools in dieser Session gesperrt. Migrationen und Functions sind nicht deployt.
   Weg: `scripts/deploy.sh` oder Supabase-Connector freigeben, dann deploye ich.
2. **Resend-Domain `mail.pileot.de`:** nicht angelegt (wartet auf Freigabe, DNS-Zugang nötig).
3. **n8n-Credentials:** über die Schnittstelle nicht anlegbar. Exakte Werte in `n8n/README.md`.
4. **Linkdomain `link.pileot.de`:** Host unbekannt.
5. **Google Business Profile API:** Antrag muss vom Profilinhaber gestellt werden.
6. **Versandgrundlage:** rechtlich nicht geklärt. Das Formular verlangt eine bestätigte
   Einwilligung; ob das für den konkreten Fall genügt, muss eine Fachperson beurteilen.

## Bekannte Grenzen V1

- Höchstens eine Anfrage pro Kundin und Standort, auch bei Folgeterminen.
- Ein Job mit Status `unknown` braucht einen manuellen Abgleich (selten, Warnung per Mail).
- Klickzahlen zeigen geöffnete Bewertungsseiten, nicht abgegebene Bewertungen.
- Nach dem Klick weiß das System nicht, ob bewertet wurde; Google bietet keine Zuordnung.
