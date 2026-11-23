#!/bin/sh
set -e
cd /app
if [ -z "${DATABASE_URL:-}${DATABASE_PRIVATE_URL:-}${POSTGRES_URL:-}${ELIOT_MIGRATE_URL:-}" ]; then
  echo "install: falta DATABASE_URL. En el servicio de la API, Variables → referencia a Postgres.DATABASE_URL"
  exit 6
fi
python ops/install_schema.py
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
