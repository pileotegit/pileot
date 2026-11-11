#!/usr/bin/env bash
# Startet ein wegwerfbares Postgres 16 (nur Unix-Socket, kein TCP) und führt die DB-Tests aus.
# Voraussetzung: Postgres-16-Binärdateien, Node >= 20, npm install.
# Variablen: PGBIN (Standard /usr/lib/postgresql/16/bin), PGPORT (54329), PGDATA_DIR (/tmp/pgcluster-review)
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${PGPORT:-54329}"
PGDATA_DIR="${PGDATA_DIR:-/tmp/pgcluster-review}"
SOCK_DIR="${SOCK_DIR:-/tmp}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Postgres läuft nicht als root. Wenn wir root sind, wechseln wir zum Benutzer pgtest.
as_pg() {
  if [ "$(id -u)" = "0" ]; then
    runuser -u pgtest -- "$@"
  else
    "$@"
  fi
}

if [ "$(id -u)" = "0" ] && ! id pgtest >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin pgtest
fi

if [ ! -d "$PGDATA_DIR" ]; then
  if [ "$(id -u)" = "0" ]; then install -d -o pgtest -g pgtest "$PGDATA_DIR"; else mkdir -p "$PGDATA_DIR"; fi
  as_pg "$PGBIN/initdb" -D "$PGDATA_DIR" -U "${PGUSER:-pgtest}" --auth=trust >/dev/null
fi

if ! as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
  as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-c port=$PGPORT -c listen_addresses='' -c unix_socket_directories=$SOCK_DIR -c fsync=off -c max_connections=200" -l "$PGDATA_DIR/server.log" -w start >/dev/null
fi

cleanup() {
  if [ "${KEEP_PG:-0}" != "1" ]; then
    as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -m fast stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cd "$ROOT"
PGHOST="$SOCK_DIR" PGPORT="$PGPORT" PGUSER="${PGUSER:-pgtest}" node --test --test-concurrency=1 "tests/db/*.test.mjs" "tests/functions/*.test.mjs"
