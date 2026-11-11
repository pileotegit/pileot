#!/usr/bin/env bash
# Browser-Test der statischen Seiten gegen die echten Handler und Postgres (setzt Chrome + Python-Playwright voraus).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
KEEP_PG=1 bash scripts/db-test.sh >/dev/null 2>&1 || true
PGHOST=/tmp PGPORT=54329 node tests/e2e/server.mjs > /tmp/rv-e2e.out 2>&1 &
PID=$!; trap 'kill $PID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do grep -q ready /tmp/rv-e2e.out 2>/dev/null && break; sleep 0.5; done
python3 tests/e2e/browser_check.py "$(head -1 /tmp/rv-e2e.out)" /tmp/rv-e2e
