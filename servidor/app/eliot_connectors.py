"""Prueba de conectores FTP/FTPS y bases remotas. Las contraseñas llegan ya descifradas solo en memoria."""
from __future__ import annotations

import ftplib
import socket
from urllib.parse import quote_plus

from app.eliot_company_db import run_select

FTP_KINDS = ("ftp", "ftps")
DB_KINDS = ("mysql", "mariadb", "postgresql", "mssql", "mongodb")
DEFAULT_PORTS = {
    "ftp": 21, "ftps": 21,
    "mysql": 3306, "mariadb": 3306, "postgresql": 5432, "mssql": 1433, "mongodb": 27017,
}


def build_db_url(kind: str, host: str, port: int, username: str, password: str, database: str) -> str:
    user = quote_plus(username)
    pwd = quote_plus(password)
    if kind == "postgresql":
        return f"postgresql://{user}:{pwd}@{host}:{port}/{database}"
    if kind in ("mysql", "mariadb"):
        return f"mysql://{user}:{pwd}@{host}:{port}/{database}"
    if kind == "mssql":
        return f"mssql://{user}:{pwd}@{host}:{port}/{database}"
    if kind == "mongodb":
        return f"mongodb://{user}:{pwd}@{host}:{port}/{database}"
    raise ValueError("unsupported database kind")


def test_ftp(kind: str, host: str, port: int, username: str, password: str, remote_path: str | None) -> None:
    timeout = 12
    client: ftplib.FTP
    if kind == "ftps":
        client = ftplib.FTP_TLS(timeout=timeout)
        client.connect(host, port, timeout=timeout)
        client.login(username, password)
        try:
            client.prot_p()
        except ftplib.error_perm:
            pass
    else:
        client = ftplib.FTP(timeout=timeout)
        client.connect(host, port, timeout=timeout)
        client.login(username, password)
    try:
        client.voidcmd("NOOP")
        if remote_path:
            client.cwd(remote_path)
        else:
            client.pwd()
    finally:
        try:
            client.quit()
        except Exception:
            try:
                client.close()
            except Exception:
                pass


def test_database(kind: str, host: str, port: int, username: str, password: str, database: str) -> None:
    url = build_db_url(kind, host, port, username, password, database)
    if kind == "mongodb":
        from pymongo import MongoClient
        client = MongoClient(url, serverSelectionTimeoutMS=8000)
        try:
            client.admin.command("ping")
        finally:
            client.close()
        return
    rows = run_select(url, "SELECT 1 AS ok")
    if not rows:
        raise RuntimeError("La base no devolvió resultado de prueba")


def test_connector(kind: str, host: str, port: int, username: str, password: str,
                   remote_path: str | None, database_name: str | None) -> str | None:
    """Devuelve None si la prueba va bien, o un mensaje corto si falla."""
    try:
        if kind in FTP_KINDS:
            test_ftp(kind, host, port, username, password, remote_path)
            return None
        if kind in DB_KINDS:
            if not database_name:
                return "Falta el nombre de la base de datos"
            test_database(kind, host, port, username, password, database_name)
            return None
        return "Tipo de conector no soportado"
    except (ftplib.all_errors, socket.timeout, TimeoutError, OSError, RuntimeError, ValueError, ImportError) as exc:
        text = str(exc).strip() or type(exc).__name__
        return text[:220]
    except Exception as exc:  # driver-specific errors (pymysql, sqlalchemy, etc.)
        text = str(exc).strip() or type(exc).__name__
        return text[:220]
