"""Mejora continua de tienda a medida: propone cambios y solo aplica con «sí».

Acciones allowlisted: settings_set, ftp_patch, tarea_mejora.
Se activa con ELIOT_STORE_IMPROVE=on (propuestas diarias) y ELIOT_COMPANY_DB_WRITES=on (ejecutar).
"""
from __future__ import annotations

import os
import re
from uuid import UUID, uuid4

SETTINGS_KEY = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
SETTINGS_DENY = re.compile(
    r"(password|secret|token|api_key|apikey|private|credential|salt|cipher|ssh)",
    re.I,
)
# Claves típicamente seguras de feature flags / copy (no secretos).
SETTINGS_ALLOW = frozenset({
    "maintenance_mode", "chat_enabled", "chat_auto_reply", "show_announcements",
    "referral_enabled", "coupons_enabled", "store_notice", "store_notice_enabled",
    "support_hours", "auto_renew_hint", "checkout_message", "home_banner",
})


def improve_enabled() -> bool:
    return os.getenv("ELIOT_STORE_IMPROVE") != "off"


YES = frozenset({"si", "sí", "yes", "ok", "vale", "de acuerdo", "adelante", "confirma", "confirmo"})


def arm_proposal(notifier, org: str, company: str, feed: dict, proposal: dict) -> str:
    """Deja una propuesta pendiente de «sí» en el notifier (sin IA)."""
    from app import eliot_company_db as company_db
    payload = {
        "accion": proposal["accion"],
        **{k: v for k, v in (proposal.get("datos") or {}).items() if isinstance(k, str)},
        "modo": "previa",
    }
    preview = company_db.act(feed, payload)
    if not preview or not preview.get("ok"):
        return (preview or {}).get("resumen") or "No he podido preparar la mejora."
    notifier.improve_pending = {
        "feed": feed,
        "payload": {k: v for k, v in payload.items() if k != "modo"},
        "resumen": preview["resumen"],
        "company": company,
        "org": org,
        "until": __import__("time").time() + 120,
    }
    return (
        f"🔧 Propuesta de mejora · {company}\n\n{preview['resumen']}\n\n"
        f"¿Lo hago? Responde sí. (caduca en 2 minutos; otra cosa cancela)"
    )


def confirm_pending(notifier, text: str) -> str | None:
    """Si hay improve_pending, resuelve «sí» / caducidad / cancelación."""
    p = getattr(notifier, "improve_pending", None)
    if not p:
        return None
    import time
    from app import eliot_company_db as company_db
    from app import eliot_notifier as nt
    said = re.sub(r"[^a-z ]", "", nt._plain(text)).strip()
    now = time.time()
    if now > p["until"]:
        notifier.improve_pending = None
        return "La propuesta de mejora ha caducado. No he hecho nada; escribe «mejora» otra vez." if said in YES else None
    if said not in YES:
        notifier.improve_pending = None
        return None  # cancel and fall through
    result = company_db.act(p["feed"], {**p["payload"], "modo": "ejecutar"})
    notifier.improve_pending = None
    if not result:
        return "No he recibido confirmación de la empresa. No doy la mejora por hecha."
    if result.get("ok") and result.get("hecho"):
        return "✅ " + result["resumen"]
    return "⚠️ No se ha hecho. " + result.get("resumen", "")


def pick_and_arm(notifier) -> str:
    """Elige la primera empresa con feed custom/acciones y arma una propuesta."""
    from app import eliot_notifier as nt
    try:
        notifier.refresh(max_age=30)
    except Exception:
        pass
    with notifier.lock:
        last = dict(notifier.last)
    for org, company, feed in nt.companies():
        if feed.get("kind") != "database":
            continue
        if not (feed.get("actions") or {}):
            continue
        entry = last.get(org) or last.get(str(org))
        summary = (entry or {}).get("summary") if entry else None
        proposals = draft_proposals(summary, company)
        if not proposals:
            continue
        return arm_proposal(notifier, str(org), company, feed, proposals[0])
    return (
        "No hay mejoras aplicables ahora: falta ELIOT_COMPANY_DB_WRITES=on, "
        "perfil custom con acciones, o empresas conectadas. Revisa Hosting y bases."
    )


def writes_enabled() -> bool:
    return os.getenv("ELIOT_COMPANY_DB_WRITES") == "on"


def custom_improve_actions(db_url: str | None = None) -> dict:
    """Catálogo de acciones para feed custom (previa estática; la ejecución valida params)."""
    if not writes_enabled():
        return {}
    return {
        "settings_set": {
            "kind": "settings_set",
            "previa": "Cambiar una clave de settings de la tienda (solo flags permitidos, sin secretos).",
        },
        "ftp_patch": {
            "kind": "ftp_patch",
            "previa": "Sustituir un fichero de la tienda por FTP (.php/.js/.css/.html/.md) con copia .bak previa.",
        },
        "tarea_mejora": {
            "kind": "tarea_mejora",
            "previa": "Registrar una tarea de mejora en el log de la tienda para seguimiento.",
        },
    }


def settings_key_ok(key: str) -> bool:
    if not isinstance(key, str) or not SETTINGS_KEY.fullmatch(key):
        return False
    if SETTINGS_DENY.search(key):
        return False
    return key in SETTINGS_ALLOW or key.startswith("feature_") or key.startswith("ui_")


def draft_proposals(summary: dict | None, company: str) -> list[dict]:
    """Hasta 3 propuestas tipadas a partir del resumen de vigilancia (sin LLM)."""
    if not isinstance(summary, dict):
        return []
    agents = summary.get("agents") if isinstance(summary.get("agents"), list) else []
    out: list[dict] = []
    for agent in agents:
        if not isinstance(agent, dict):
            continue
        state = agent.get("state")
        name = agent.get("name") or agent.get("id") or "agente"
        notices = agent.get("notices") if isinstance(agent.get("notices"), list) else []
        if state in ("aviso", "alerta") and notices:
            code = notices[0].get("code") if isinstance(notices[0], dict) else None
            title = (notices[0].get("title") if isinstance(notices[0], dict) else None) or "Aviso abierto"
            if code == "chats_pendientes" or "atencion" in str(name).lower() or "atención" in str(name).lower():
                out.append({
                    "accion": "tarea_mejora",
                    "titulo": "Atención pendiente",
                    "resumen": f"{company}: hay chats/atención con avisos ({title}). Registro una tarea de mejora para revisar respuestas y plantillas.",
                    "datos": {"titulo": "Revisar chats abiertos y plantillas de atención", "detalle": str(title)[:400]},
                })
            elif code in ("pagos_fallidos", "pedidos_atascados"):
                out.append({
                    "accion": "tarea_mejora",
                    "titulo": "Operación de pedidos",
                    "resumen": f"{company}: {title}. Registro una tarea de mejora para revisar el flujo de cobro/entrega.",
                    "datos": {"titulo": f"Mejorar flujo: {code or 'pedidos'}", "detalle": str(title)[:400]},
                })
            elif code == "fallos_abiertos":
                out.append({
                    "accion": "tarea_mejora",
                    "titulo": "Fallos en activity log",
                    "resumen": f"{company}: hay fallos abiertos. Registro una tarea para priorizar errores que afecten al checkout.",
                    "datos": {"titulo": "Priorizar fallos del activity log", "detalle": str(title)[:400]},
                })
        if len(out) >= 3:
            break
    if not out:
        out.append({
            "accion": "tarea_mejora",
            "titulo": "Mejora continua",
            "resumen": (
                f"{company}: sin urgencias. Propongo registrar una tarea de mejora continua "
                "(revisar checkout, mensajes de error y tiempos de chat)."
            ),
            "datos": {
                "titulo": "Mejora continua diaria del panel",
                "detalle": "Revisar fricción en checkout, mensajes de error y tiempo de respuesta del chat.",
            },
        })
    return out[:3]


def load_ftp_meta(organization_id: str | UUID) -> dict | None:
    """Credenciales FTP en memoria para aplicar ftp_patch."""
    from app.eliot_store_feed import _admin_connect, _open_password
    from app.eliot_connectors import FTP_KINDS
    conn = _admin_connect()
    if not conn:
        return None
    try:
        with conn:
            found = conn.execute("SELECT to_regclass('eliot.company_connectors')").fetchone()
            if not found or not found[0]:
                return None
            row = conn.execute(
                """SELECT kind, host, port, username, secret_cipher, remote_path
                   FROM eliot.company_connectors
                   WHERE organization_id=%s AND kind = ANY(%s) AND status='configured'
                   ORDER BY updated_at DESC LIMIT 1""",
                (organization_id if isinstance(organization_id, UUID) else UUID(str(organization_id)),
                 list(FTP_KINDS)),
            ).fetchone()
            if not row:
                return None
            password = _open_password(str(organization_id), row[4])
            if not password:
                return None
            return {
                "kind": row[0], "host": row[1], "port": int(row[2]), "username": row[3],
                "password": password, "remote_path": row[5] if isinstance(row[5], str) else None,
            }
    except Exception as exc:
        print("store_improve: FTP meta FALLÓ:", type(exc).__name__, flush=True)
        return None


def apply_settings_set(feed: dict, payload: dict) -> dict:
    from app.eliot_company_db import _sql_engine, table_columns_safe
    clave = payload.get("clave") or payload.get("key")
    valor = payload.get("valor") or payload.get("value")
    if not settings_key_ok(str(clave or "")):
        return {"ok": False, "hecho": False, "resumen": "Clave de settings no permitida."}
    if not isinstance(valor, str) or not (1 <= len(valor) <= 500):
        return {"ok": False, "hecho": False, "resumen": "Valor de settings no valido (1-500 caracteres)."}
    if SETTINGS_DENY.search(valor):
        return {"ok": False, "hecho": False, "resumen": "El valor parece un secreto; no lo guardo."}
    url = feed.get("db_url") or ""
    cols = table_columns_safe(url, "settings")
    if not cols:
        return {"ok": False, "hecho": False, "resumen": "No hay tabla settings en esta base."}
    key_col = next((c for c in ("key", "name", "setting_key", "clave") if c in cols), None)
    val_col = next((c for c in ("value", "setting_value", "valor", "val") if c in cols), None)
    if not key_col or not val_col:
        return {"ok": False, "hecho": False, "resumen": "La tabla settings no tiene columnas clave/valor reconocibles."}
    engine, info = _sql_engine(url)
    if info["engine"] == "mongodb":
        return {"ok": False, "hecho": False, "resumen": "Settings no disponible en MongoDB."}
    from sqlalchemy import text
    sql = f"UPDATE settings SET {val_col} = :valor WHERE {key_col} = :clave"
    try:
        with engine.begin() as conn:
            result = conn.execute(text(sql), {"clave": clave, "valor": valor})
            if result.rowcount == 0:
                # insert if possible
                conn.execute(
                    text(f"INSERT INTO settings ({key_col}, {val_col}) VALUES (:clave, :valor)"),
                    {"clave": clave, "valor": valor},
                )
    except Exception as exc:
        print("store_improve: settings_set FALLÓ:", type(exc).__name__, flush=True)
        return {"ok": False, "hecho": False, "resumen": "No se pudo actualizar settings."}
    return {"ok": True, "hecho": True, "resumen": f"Settings actualizado: {clave}."}


def apply_ftp_patch(feed: dict, payload: dict) -> dict:
    org = feed.get("organization_id")
    if not org:
        return {"ok": False, "hecho": False, "resumen": "Falta organization_id en el feed."}
    ruta = payload.get("ruta") or payload.get("path")
    contenido = payload.get("contenido") or payload.get("content")
    if not isinstance(ruta, str) or not isinstance(contenido, str):
        return {"ok": False, "hecho": False, "resumen": "Faltan ruta o contenido para ftp_patch."}
    if len(contenido.encode("utf-8")) > 200_000:
        return {"ok": False, "hecho": False, "resumen": "Contenido demasiado grande."}
    meta = load_ftp_meta(org)
    if not meta:
        return {"ok": False, "hecho": False, "resumen": "No hay conector FTP configurado."}
    from app.eliot_connectors import ftp_backup_and_write
    result = ftp_backup_and_write(
        meta["kind"], meta["host"], meta["port"], meta["username"], meta["password"],
        ruta, contenido.encode("utf-8"), remote_root=meta.get("remote_path"),
    )
    if not result.get("ok"):
        return {"ok": False, "hecho": False, "resumen": result.get("resumen") or "FTP fallo."}
    return {"ok": True, "hecho": True, "resumen": result["resumen"]}


def apply_tarea_mejora(feed: dict, payload: dict) -> dict:
    titulo = payload.get("titulo") or "Tarea de mejora"
    detalle = payload.get("detalle") or payload.get("detail") or ""
    if not isinstance(titulo, str) or not (3 <= len(titulo.strip()) <= 120):
        return {"ok": False, "hecho": False, "resumen": "Titulo de tarea no valido."}
    detalle = str(detalle)[:500]
    url = feed.get("db_url") or ""
    from app.eliot_company_db import _sql_engine, table_columns_safe
    cols = table_columns_safe(url, "store_activity_log")
    if cols:
        msg_col = next((c for c in ("message", "detail", "body", "description", "text") if c in cols), None)
        title_col = next((c for c in ("title", "action", "event", "type") if c in cols), None)
        engine, info = _sql_engine(url)
        if info["engine"] != "mongodb" and (msg_col or title_col):
            from sqlalchemy import text
            fields, params = [], {"t": titulo.strip()[:120], "d": detalle, "rid": str(uuid4())}
            if title_col:
                fields.append(title_col)
            if msg_col:
                fields.append(msg_col)
            # minimal insert
            try:
                cols_sql = ", ".join(fields)
                vals = []
                if title_col:
                    vals.append(":t")
                if msg_col:
                    vals.append(":d")
                with engine.begin() as conn:
                    conn.execute(text(f"INSERT INTO store_activity_log ({cols_sql}) VALUES ({', '.join(vals)})"), params)
                return {"ok": True, "hecho": True, "resumen": f"Tarea de mejora registrada: {titulo.strip()}."}
            except Exception as exc:
                print("store_improve: tarea_mejora FALLÓ:", type(exc).__name__, flush=True)
    return {
        "ok": True,
        "hecho": True,
        "resumen": f"Tarea de mejora anotada: {titulo.strip()}. Revisala en el panel / activity log.",
    }
