"""Conexión a la base de La Factoría: PostgreSQL nativo (recomendado) u otro motor SQL.

Lee DATABASE_URL o las variables ELIOT_IDENTITY_DB_*. En PostgreSQL se conservan las
funciones y el aislamiento por filas. En MySQL, MariaDB, SQLite y SQL Server se usa
el almacén portable (app/eliot_portable.py): misma API, aislamiento en la aplicación.
"""
from __future__ import annotations

import os
import re
from urllib.parse import unquote, urlparse

import psycopg

Error = psycopg.Error
errors = psycopg.errors
OperationalError = psycopg.OperationalError

ENGINES = ("postgresql", "postgres", "mysql", "mariadb", "sqlite", "mssql", "sqlserver")
STRICT_USER = "eliot_identity_app"
STRICT_DB = "eliot_dev"
DB_ENV = ("ELIOT_IDENTITY_DB_HOST", "ELIOT_IDENTITY_DB_PORT", "ELIOT_IDENTITY_DB_NAME",
          "ELIOT_IDENTITY_DB_USER", "ELIOT_IDENTITY_DB_PASSWORD")
ORIGIN = re.compile(r"^https?://[A-Za-z0-9.-]{1,200}(:[0-9]{2,5})?$")
DEFAULT_ORIGINS = ("https://app.tu-factoria.example",)


def on_managed_paas():
    return bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_ENVIRONMENT_ID")
                or os.getenv("RENDER") or os.getenv("FLY_APP_NAME"))


def strict_accounts():
    default = "off" if on_managed_paas() else "on"
    return os.getenv("ELIOT_DB_STRICT_ACCOUNTS", default) != "off"


def parse_url(url: str) -> dict:
    """Descompone una URL de base (postgres, mysql, mariadb, sqlite, mssql, mongodb)."""
    if not url or not isinstance(url, str):
        raise RuntimeError("Database URL is empty")
    raw = url.strip()
    if raw.startswith("sqlite:"):
        path = raw.split("sqlite:", 1)[1]
        if path.startswith("///"):
            path = path[3:] or ":memory:"
        elif path.startswith("//"):
            path = path[2:]
        return {"engine": "sqlite", "path": path or ":memory:", "url": raw}
    parsed = urlparse(raw)
    engine = (parsed.scheme or "").split("+")[0].lower()
    if engine in ("postgres", "postgresql"):
        engine = "postgresql"
    elif engine in ("sqlserver", "mssql"):
        engine = "mssql"
    elif engine == "mariadb":
        engine = "mariadb"
    elif engine == "mysql":
        engine = "mysql"
    elif engine == "mongodb":
        engine = "mongodb"
    else:
        raise RuntimeError("Unsupported database engine")
    dbname = unquote((parsed.path or "").lstrip("/"))
    if engine == "mongodb" and "/" in dbname:
        dbname = dbname.split("/", 1)[0]
    return {
        "engine": engine,
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or {"postgresql": 5432, "mysql": 3306, "mariadb": 3306, "mssql": 1433, "mongodb": 27017}[engine],
        "user": unquote(parsed.username) if parsed.username else "",
        "password": unquote(parsed.password) if parsed.password else "",
        "dbname": dbname,
        "url": raw,
    }


def detect_engine():
    url = os.getenv("DATABASE_URL") or os.getenv("ELIOT_DATABASE_URL") or ""
    if url:
        return parse_url(url)["engine"]
    named = (os.getenv("ELIOT_DB_ENGINE") or "postgresql").strip().lower()
    if named in ("postgres", "postgresql"):
        return "postgresql"
    if named not in ENGINES and named != "mongodb":
        raise RuntimeError("Unsupported database engine")
    return named


def is_postgres():
    return detect_engine() in ("postgresql", "postgres")


def frontend_origins():
    extra = os.getenv("ELIOT_FRONTEND_ORIGINS") or ""
    configured = tuple(item.strip().rstrip("/") for item in extra.split(",") if item.strip())
    approved = configured or DEFAULT_ORIGINS
    for origin in approved:
        if not ORIGIN.fullmatch(origin):
            raise RuntimeError("An approved development frontend origin is required")
    origin = os.environ.get("ELIOT_FRONTEND_ORIGIN") or approved[0]
    if origin not in approved:
        raise RuntimeError("An approved development frontend origin is required")
    return approved


def identity_params():
    """Parámetros para el rol de la API. Compatible con psycopg.connect en PostgreSQL."""
    url = os.getenv("DATABASE_URL") or os.getenv("ELIOT_DATABASE_URL")
    if url:
        info = parse_url(url)
        if info["engine"] == "mongodb":
            raise RuntimeError("La base de La Factoría no puede ser MongoDB; usa SQL. MongoDB sí vale para el conector de una empresa.")
        if info["engine"] == "sqlite":
            if strict_accounts():
                raise RuntimeError("Restricted identity account required")
            return {"engine": "sqlite", "path": info["path"], "connect_timeout": 6}
        if info["engine"] == "postgresql":
            user, name = info["user"], info["dbname"]
            if strict_accounts() and (user != STRICT_USER or name != os.getenv("ELIOT_DB_NAME", STRICT_DB)):
                raise RuntimeError("Restricted identity account required")
            return {"conninfo": url, "connect_timeout": 6, "engine": "postgresql"}
        if strict_accounts():
            raise RuntimeError("Restricted identity account required")
        return {"engine": info["engine"], "url": url, "connect_timeout": 6}
    if any(not os.getenv(n) for n in DB_ENV):
        raise RuntimeError("Identity database is not configured")
    user, name = os.environ[DB_ENV[3]], os.environ[DB_ENV[2]]
    expected_name = os.getenv("ELIOT_DB_NAME", STRICT_DB)
    if strict_accounts() and (user != STRICT_USER or name != expected_name):
        raise RuntimeError("Restricted identity account required")
    engine = detect_engine()
    params = dict(host=os.environ[DB_ENV[0]], port=int(os.environ[DB_ENV[1]]),
                  dbname=name, user=user, password=os.environ[DB_ENV[4]],
                  connect_timeout=6, engine=engine)
    return params


def worker_params():
    prefix = "ELIOT_WORKER_DB_"
    values = {name: os.getenv(prefix + name) for name in ("HOST", "PORT", "NAME", "USER", "PASSWORD")}
    if any(not value for value in values.values()):
        raise RuntimeError("Worker database is not configured")
    if strict_accounts() and (values["NAME"] != os.getenv("ELIOT_DB_NAME", STRICT_DB)
                              or not re.fullmatch(r"eliot_worker_[a-z0-9_]{1,48}", values["USER"])):
        raise RuntimeError("Separate restricted worker login required")
    return dict(host=values["HOST"], port=int(values["PORT"]), dbname=values["NAME"],
                user=values["USER"], password=values["PASSWORD"], connect_timeout=6,
                options="-c statement_timeout=15000 -c lock_timeout=5000", engine="postgresql")


def connect(**kwargs):
    """Misma firma que psycopg.connect: en PostgreSQL es psycopg; en el resto, el almacén portable."""
    engine = kwargs.pop("engine", None) or "postgresql"
    if engine in ("postgresql", "postgres"):
        conn = psycopg.connect(**kwargs)
        if on_managed_paas():
            conn.execute("SET ROLE eliot_identity")
        return conn
    from app import eliot_portable
    return eliot_portable.connect(engine, kwargs)
