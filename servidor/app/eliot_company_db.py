"""Conector de la base de una empresa: PostgreSQL, MySQL, MariaDB, SQLite, SQL Server o MongoDB.

La Factoría no copia fichas de clientes. Solo ejecuta las consultas que el operador
dejó escritas en ELIOT_PORTAL_FEEDS (SELECT para avisos y cifras; escrituras solo si
están en la configuración de acciones) y las reduce al contrato de Freddy.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from app.eliot_db import parse_url

SELECT_ONLY = re.compile(r"^\s*select\b", re.I)
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
REF_PREFIX = re.compile(r"^[a-z]{2,5}-[A-Z]{3}-$")
AGENT_ID = re.compile(r"^[a-z][a-z_]{1,29}$")
NOTICE_CODE = re.compile(r"^[a-z_]{2,30}$")
NOTICE_TEXT = re.compile(r"^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .,:;()«»¿?¡!%€$/+'-]{3,140}$")
CAPABILITIES = ("repository", "website", "seo", "marketing", "email", "orders", "monitoring", "automation")
LEVELS = ("urgente", "importante", "info")


def iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _sql_engine(url):
    info = parse_url(url)
    if info["engine"] == "mongodb":
        return None, info
    from sqlalchemy import create_engine, text
    raw = info["url"]
    connect_args: dict = {}
    if info["engine"] == "sqlite":
        raw = "sqlite+pysqlite:///" + (info["path"] if info["path"] != ":memory:" else ":memory:")
    elif info["engine"] in ("mysql", "mariadb") and raw.startswith(("mysql://", "mariadb://")):
        raw = re.sub(r"^(mysql|mariadb)://", "mysql+pymysql://", raw, count=1)
        # Hostings compartidos: Railway suele conectar sin SSL cliente.
        connect_args = {"connect_timeout": 8, "read_timeout": 12, "write_timeout": 12, "ssl_disabled": True}
    elif info["engine"] == "mssql" and not raw.startswith("mssql+"):
        raw = re.sub(r"^(mssql|sqlserver)://", "mssql+pyodbc://", raw, count=1)
        if "driver=" not in raw:
            raw += ("&" if "?" in raw else "?") + "driver=ODBC+Driver+18+for+SQL+Server&TrustServerCertificate=yes"
    elif info["engine"] == "postgresql" and raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://"):]
    engine = create_engine(raw, future=True, connect_args=connect_args)
    return engine, info


def run_select(url, sql, params=None):
    if not isinstance(sql, str) or not SELECT_ONLY.match(sql) or len(sql) > 4000:
        return []
    engine, info = _sql_engine(url)
    if info["engine"] == "mongodb":
        return _mongo(info, sql if isinstance(sql, dict) else {})
    from sqlalchemy import text
    with engine.connect() as conn:
        result = conn.execute(text(sql), params or {})
        columns = list(result.keys())
        rows = []
        for raw in result.fetchmany(100):
            rows.append({columns[i]: raw[i] for i in range(len(columns))})
        return rows


def list_mysql_tables(url: str) -> list[str]:
    """SHOW TABLES — no pasa por el filtro SELECT-only de run_select."""
    engine, info = _sql_engine(url)
    if info["engine"] not in ("mysql", "mariadb"):
        return []
    from sqlalchemy import text
    with engine.connect() as conn:
        rows = conn.execute(text("SHOW TABLES")).fetchmany(400)
        return [str(row[0]).lower() for row in rows if row and row[0]]


def explain_db_error(exc: BaseException) -> str:
    """Frase corta y segura para Telegram/UI (sin contraseñas ni rutas)."""
    msg = f"{type(exc).__name__}: {exc}".lower()
    codes = re.findall(r"\b([12]\d{3})\b", msg)
    code = codes[0] if codes else None
    if "access denied" in msg or code == "1045":
        return "MySQL rechazo el acceso. Anade % o la IP de Railway en Remote MySQL."
    if "connection refused" in msg or "10061" in msg:
        return "MySQL rechazo el puerto. Comprueba host publico y 3306 abierto."
    if (
        "can't connect" in msg or code == "2003" or "timed out" in msg or "timeout" in msg
        or "name or service not known" in msg or "getaddrinfo" in msg or "nodename" in msg
    ):
        return "No hay conexion con MySQL desde el servidor. Abre el puerto o el firewall."
    if "gone away" in msg or code == "2006":
        return "MySQL cerro la conexion. Revisa limites del hosting."
    if "lost connection" in msg or code == "2013":
        return "Se perdio la conexion con MySQL a media consulta."
    if "doesn't exist" in msg or code == "1146" or "no such table" in msg:
        return "No existe la tabla de pedidos. Revisa el prefijo de WordPress."
    if "unknown database" in msg or code == "1049":
        return "El nombre de la base de datos no existe en MySQL."
    if "unknown column" in msg or code == "1054":
        return "La tabla existe pero las columnas no coinciden. Revisa el perfil Woo."
    if "ssl" in msg:
        return "MySQL rechazo la conexion SSL. Revisa el hosting de la base."
    cls = type(exc).__name__
    if code and re.fullmatch(r"\d{4}", code):
        return f"Error MySQL {code} ({cls}). Revisa Hosting y bases."
    if re.fullmatch(r"[A-Za-z]{3,40}", cls):
        return f"Fallo {cls} al hablar con MySQL. Revisa Hosting y bases."
    return "La consulta a la tienda ha fallado. Revisa Hosting y bases."


def _mongo(info, spec):
    try:
        from pymongo import MongoClient
    except ImportError as exc:
        raise RuntimeError("pymongo is required for MongoDB company feeds") from exc
    collection = spec.get("collection")
    if not isinstance(collection, str) or not IDENT.fullmatch(collection):
        return []
    filt = spec.get("filter") if isinstance(spec.get("filter"), dict) else {}
    client = MongoClient(info["url"], serverSelectionTimeoutMS=4000)
    try:
        dbn = info["dbname"] or "test"
        cursor = client[dbn][collection].find(filt).limit(100)
        return list(cursor)
    finally:
        client.close()


def _watchers(feed):
    raw = feed.get("watchers") if isinstance(feed.get("watchers"), list) else []
    out = []
    for item in raw[:12]:
        if not isinstance(item, dict):
            continue
        ident, name, cap = item.get("id"), item.get("nombre"), item.get("capacidad")
        sql, level, code = item.get("sql"), item.get("nivel"), item.get("clave")
        prefix = item.get("ref_prefix")
        if not (isinstance(ident, str) and AGENT_ID.fullmatch(ident)):
            continue
        if not (isinstance(name, str) and 3 <= len(name) <= 60):
            continue
        if cap not in CAPABILITIES or level not in LEVELS:
            continue
        if not (isinstance(code, str) and NOTICE_CODE.fullmatch(code)):
            continue
        if not (isinstance(prefix, str) and REF_PREFIX.fullmatch(prefix)):
            continue
        if not (isinstance(sql, str) and SELECT_ONLY.match(sql) and len(sql) <= 4000):
            continue
        title = item.get("titulo") if isinstance(item.get("titulo"), str) else None
        proposal = item.get("propuesta") if isinstance(item.get("propuesta"), str) else None
        if title and not NOTICE_TEXT.fullmatch(title.strip()):
            title = None
        if proposal and not NOTICE_TEXT.fullmatch(proposal.strip()):
            proposal = None
        out.append({"id": ident, "nombre": name, "capacidad": cap, "sql": sql, "nivel": level,
                    "clave": code, "ref_prefix": prefix, "titulo": title, "propuesta": proposal,
                    "id_field": item.get("id_field") if isinstance(item.get("id_field"), str) else "id"})
    return out


def _queries(feed):
    raw = feed.get("queries") if isinstance(feed.get("queries"), dict) else {}
    out = {}
    for key, spec in list(raw.items())[:20]:
        if not (isinstance(key, str) and NOTICE_CODE.fullmatch(key)):
            continue
        if isinstance(spec, str):
            spec = {"sql": spec}
        if not isinstance(spec, dict):
            continue
        sql = spec.get("sql")
        if not (isinstance(sql, str) and SELECT_ONLY.match(sql) and len(sql) <= 4000):
            continue
        out[key] = sql
    return out


def _actions(feed):
    if os.getenv("ELIOT_COMPANY_DB_WRITES") != "on":
        return {}
    raw = feed.get("actions") if isinstance(feed.get("actions"), dict) else {}
    out = {}
    for key, spec in list(raw.items())[:20]:
        if not (isinstance(key, str) and NOTICE_CODE.fullmatch(key) and isinstance(spec, dict)):
            continue
        previa, ejecutar = spec.get("previa"), spec.get("sql")
        if not (isinstance(previa, str) and 3 <= len(previa) <= 200):
            continue
        if not (isinstance(ejecutar, str) and re.match(r"^\s*(update|insert)\b", ejecutar, re.I) and len(ejecutar) <= 4000):
            continue
        out[key] = {"previa": previa, "sql": ejecutar}
    return out


def summary(feed):
    url = feed.get("db_url") or ""
    watchers = _watchers(feed)
    slug = feed.get("empresa") if isinstance(feed.get("empresa"), str) else "empresa"
    agents, seen = [], set()
    try:
        for watcher in watchers:
            if watcher["id"] in seen:
                continue
            seen.add(watcher["id"])
            try:
                rows = run_select(url, watcher["sql"])
            except Exception as exc:
                # Sigue listando el vigilante en error: así Telegram/estado no quedan en blanco.
                hint = explain_db_error(exc)
                print("company_db: vigilante", watcher["id"], type(exc).__name__, str(exc)[:180], flush=True)
                agents.append({"id": watcher["id"], "nombre": watcher["nombre"], "capacidad": watcher["capacidad"],
                               "estado": "error", "alertas": {"urgentes": 0, "importantes": 0, "informativas": 0},
                               "avisos": [{"nivel": "info", "clave": "consulta_fallida", "n": 1, "refs": [],
                                           "titulo": "No pude consultar la tienda", "propuesta": hint}]})
                continue
            refs, field = [], watcher["id_field"]
            for row in rows:
                ident = row.get(field)
                if ident is None:
                    continue
                refs.append(f"{watcher['ref_prefix']}{ident}")
            notices = []
            if refs:
                notice = {"nivel": watcher["nivel"], "clave": watcher["clave"], "n": len(refs),
                          "refs": refs[:6]}
                if watcher["titulo"]:
                    notice["titulo"] = watcher["titulo"].replace("{n}", str(len(refs)))
                if watcher["propuesta"]:
                    notice["propuesta"] = watcher["propuesta"]
                notices.append(notice)
            level_counts = {"urgentes": 0, "importantes": 0, "informativas": 0}
            for n in notices:
                level_counts[{"urgente": "urgentes", "importante": "importantes", "info": "informativas"}[n["nivel"]]] += 1
            state = "alerta" if level_counts["urgentes"] else ("aviso" if notices else "ok")
            agents.append({"id": watcher["id"], "nombre": watcher["nombre"], "capacidad": watcher["capacidad"],
                           "estado": state, "alertas": level_counts, "avisos": notices})
    except Exception:
        return None, "portal_unreachable"
    queries = list(_queries(feed))
    actions = list(_actions(feed))
    payload = {"ok": True, "empresa": slug if re.fullmatch(r"^[a-z0-9-]{2,40}$", slug) else "empresa",
               "version": 1, "generado": iso(), "agentes": agents,
               "consultas": queries, "acciones": actions,
               "vigilancia": {"contando_desde": iso(), "ultima_ronda_programada": None}}
    return payload, None


def query(feed, kind, params):
    url = feed.get("db_url") or ""
    catalog = _queries(feed)
    sql = catalog.get(kind)
    if not sql:
        return None
    try:
        rows = run_select(url, sql, params if isinstance(params, dict) else {})
    except Exception:
        return None
    if not rows:
        return {}
    first = rows[0]
    if len(rows) == 1:
        return {str(k)[:40]: first[k] for k in first}
    return {"filas": [{str(k)[:40]: row[k] for k in row} for row in rows[:30]]}


def act(feed, payload):
    if not isinstance(payload, dict):
        return None
    kind = payload.get("accion")
    catalog = _actions(feed)
    spec = catalog.get(kind) if isinstance(kind, str) else None
    if spec is None:
        return {"ok": False, "hecho": False, "resumen": "Acción no configurada en esta empresa."}
    modo = payload.get("modo")
    if modo != "ejecutar":
        return {"ok": True, "hecho": False, "resumen": spec["previa"][:900]}
    engine, info = _sql_engine(feed.get("db_url") or "")
    if info["engine"] == "mongodb":
        return {"ok": False, "hecho": False, "resumen": "Esta acción no está disponible en MongoDB."}
    from sqlalchemy import text
    try:
        with engine.begin() as conn:
            conn.execute(text(spec["sql"]), payload if isinstance(payload, dict) else {})
    except Exception:
        return {"ok": False, "hecho": False, "resumen": "La empresa no ha podido ejecutar la acción."}
    return {"ok": True, "hecho": True, "resumen": "Hecho."}
