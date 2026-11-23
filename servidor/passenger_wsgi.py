"""Entrada WSGI para hosting con Passenger (cPanel «Setup Python App», PythonAnywhere).

El API es ASGI (FastAPI). Passenger habla WSGI: este archivo lo envuelve. Sin websockets.
Carga las variables de servidor/.env si el panel no las inyecta.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


load_dotenv(ROOT / ".env")

from a2wsgi import ASGIMiddleware  # noqa: E402
from app.main import app as asgi_app  # noqa: E402

application = ASGIMiddleware(asgi_app)
