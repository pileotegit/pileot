#!/usr/bin/env bash
# Deployment auf das Supabase-Projekt. Voraussetzungen:
#   - SUPABASE_ACCESS_TOKEN (Personal Access Token, Dashboard > Account > Access Tokens)
#   - SUPABASE_DB_PASSWORD (Datenbankpasswort des Projekts)
#   - Secrets aus .env.example sind gesetzt (siehe docs/RUNBOOK.md, Schritt 3)
# Das Skript ändert nichts an Mandanten und schaltet keinen Versand frei.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
REF="${SUPABASE_PROJECT_REF:-ayostbgfagrncgfmgyms}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN fehlt}"
: "${SUPABASE_DB_PASSWORD:?SUPABASE_DB_PASSWORD fehlt}"

echo "1/3 Tests"
npm test

echo "2/3 Migrationen auf $REF"
npx --yes supabase@latest link --project-ref "$REF" --password "$SUPABASE_DB_PASSWORD"
npx --yes supabase@latest db push --password "$SUPABASE_DB_PASSWORD"

echo "3/3 Edge Functions"
for f in rv-ingest rv-jobs rv-click rv-unsubscribe rv-resend-webhook; do
  npx --yes supabase@latest functions deploy "$f" --project-ref "$REF" --no-verify-jwt
done
echo "Fertig. Globaler Versand bleibt pausiert, bis rv_set_global_send_paused(false) aufgerufen wird."
