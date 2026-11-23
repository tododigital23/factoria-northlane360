"""Pequeño puente HTTP para la base de una empresa.

Se instala en el VPS o el hosting de ESA empresa. Habla el contrato de Freddy
(resumen-freddy, consulta-freddy, accion-freddy) y lee PostgreSQL, MySQL, MariaDB,
SQLite, SQL Server o MongoDB. La Factoría no necesita ver la base: solo este puente.
"""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("PYTHONPATH", str(ROOT))
import sys
sys.path.insert(0, str(ROOT))

from app import eliot_company_db  # noqa: E402


def load_feed():
    path = os.getenv("FREDDY_DB_CONFIG") or str(Path(__file__).with_name("empresa.json"))
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    data["db_url"] = os.environ["FREDDY_DB_URL"]
    data["secret"] = os.environ["FREDDY_SECRET"]
    return data


def authorized(handler):
    expected = os.environ["FREDDY_SECRET"]
    got = (handler.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
    return got == expected and len(expected) >= 24


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("conector-db: " + (fmt % args) + "\n")

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not authorized(self):
            return self._send(401, {"ok": False, "error": "no autorizado"})
        path = urlparse(self.path).path.rstrip("/")
        feed = load_feed()
        if path.endswith("resumen-freddy"):
            payload, reason = eliot_company_db.summary(feed)
            return self._send(200 if payload else 503, payload or {"ok": False, "error": reason})
        if path.endswith("consulta-freddy"):
            qs = parse_qs(urlparse(self.path).query)
            kind = (qs.get("tipo") or [""])[0]
            params = {k: v[0] for k, v in qs.items() if k != "tipo"}
            datos = eliot_company_db.query(feed, kind, params)
            if datos is None:
                return self._send(404, {"ok": False, "error": "consulta desconocida"})
            return self._send(200, {"ok": True, "tipo": kind, "datos": datos})
        return self._send(404, {"ok": False})

    def do_POST(self):
        if not authorized(self):
            return self._send(401, {"ok": False, "error": "no autorizado"})
        path = urlparse(self.path).path.rstrip("/")
        if not path.endswith("accion-freddy"):
            return self._send(404, {"ok": False})
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        body = eliot_company_db.act(load_feed(), payload)
        return self._send(200, body or {"ok": False, "hecho": False, "resumen": "Sin respuesta"})


def main():
    host, port = os.getenv("FREDDY_DB_BIND", "127.0.0.1"), int(os.getenv("FREDDY_DB_PORT", "8787"))
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
