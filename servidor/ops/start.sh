#!/bin/sh
set -e
cd /app
python ops/install_schema.py
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
