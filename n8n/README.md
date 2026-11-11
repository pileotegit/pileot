# n8n-Workflows (pileotn8n.app.n8n.cloud)

n8n ist nur Auslöser. Alle Fachlogik liegt in Postgres und den Edge Functions. Die Workflows
sind als **Entwürfe** angelegt (nicht veröffentlicht, nicht aktiv) im persönlichen Projekt.

| Workflow | ID | Auslöser | Ruft auf |
|---|---|---|---|
| A: Abschluss aufnehmen | EP69qtT6UDrMzzHa | Formular (Basic Auth), Pfad `pileot-termin-abgeschlossen` | `rv-ingest` |
| B: Versand | GT9rAZphJuYReD6N | alle 15 Minuten, 08:00 bis 18:45 | `rv-jobs` action `send` |
| C: Provider-Webhooks | (kein n8n) | Resend ruft direkt `rv-resend-webhook` auf | Signaturprüfung am Rohbody |
| D: Google-Abgleich | pQIwls0pxGVwJAWy | täglich 05:23 | `rv-jobs` action `google-sync` |
| E: Wochenbericht | Rfog4G9Z0P98ufGG | Mo und Di, stündlich 06:17 bis 12:17 | `rv-jobs` action `weekly-report` |
| F: Betrieb | nWrd6Vk21nRwgntf | alle 4 Stunden (:07) und täglich 03:37 | `rv-jobs` actions `ops` und `purge` |

Alle Workflows laufen in der Zeitzone Europe/Berlin (Workflow-Einstellung). Erfolgreiche
Ausführungen werden nicht gespeichert, damit keine Kundendaten in n8n liegen bleiben.

Takt bewusst sparsam: n8n Cloud Starter enthält 2.500 Ausführungen pro Monat. Geschätzt:
B ca. 1.340, F ca. 210, D ca. 30, E ca. 15, A je Formulareintrag 1. Summe ohne Formular ca. 1.600. Fachlich zeitkritisch ist nichts davon:
Versandfenster und Berichtswoche rechnet die Datenbank in der Zeitzone des Mandanten.

## Credentials (in n8n anlegen, nie im Repo)

| Name (exakt) | Typ | Feld | Wert |
|---|---|---|---|
| `PILEOT Review Worker` | Header Auth | Name: `x-rv-worker-secret` | Value: der WORKER_SECRET (gleicher Wert wie das Supabase-Secret) |
| `PILEOT Studio Integration Key` | Header Auth | Name: `Authorization` | Value: `Bearer rvk_...` (Ausgabe von `rv_create_integration`) |
| `PILEOT Studio Formular Login` | Basic Auth | User / Password | frei wählen, der Inhaberin geben |

Die Quelltexte im SDK-Format liegen in `workflows/`.
