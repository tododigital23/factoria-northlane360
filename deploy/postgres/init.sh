#!/bin/bash
set -euo pipefail
IDENT_PW="${ELIOT_IDENTITY_DB_PASSWORD:?ELIOT_IDENTITY_DB_PASSWORD}"
WORKER_PW="${ELIOT_WORKER_DB_PASSWORD:-$IDENT_PW}"
ident_sql=${IDENT_PW//\'/\'\'}
worker_sql=${WORKER_PW//\'/\'\'}

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eliot_migrator') THEN
    CREATE ROLE eliot_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eliot_identity') THEN
    CREATE ROLE eliot_identity NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eliot_execution_worker') THEN
    CREATE ROLE eliot_execution_worker NOLOGIN;
  END IF;
END
\$\$;
CREATE SCHEMA IF NOT EXISTS eliot AUTHORIZATION eliot_migrator;
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eliot_identity_app') THEN
    EXECUTE 'CREATE USER eliot_identity_app LOGIN PASSWORD ''$ident_sql''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eliot_worker_documents') THEN
    EXECUTE 'CREATE USER eliot_worker_documents LOGIN PASSWORD ''$worker_sql''';
  END IF;
END
\$\$;
GRANT eliot_identity TO eliot_identity_app;
GRANT eliot_execution_worker TO eliot_worker_documents;
GRANT eliot_migrator TO CURRENT_USER;
ALTER ROLE eliot_identity_app SET ROLE eliot_identity;
ALTER ROLE eliot_worker_documents SET ROLE eliot_execution_worker;
SQL
