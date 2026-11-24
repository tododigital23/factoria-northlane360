"""Operación de tienda desde un conector MySQL/MariaDB/PostgreSQL ya guardado.

Sin ELIOT_PORTAL_FEEDS: si la empresa tiene una base conectada y probada, Freddy vigila
pedidos atascados, fallos de pago, chats sin atender y ventas del día (reporte nocturno).
"""
from __future__ import annotations

import json
import os
import re
from uuid import UUID

from app.eliot_connectors import DB_KINDS, build_db_url
from app.eliot_storage_crypto import StorageCryptoError, configured as crypto_ready, unseal

PROFILES = ("generic", "woocommerce", "prestashop", "custom")
SLUG = re.compile(r"^[a-z0-9-]{2,40}$")
TABLE_PREFIX = re.compile(r"^[A-Za-z0-9_]{1,20}$")
COL_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,63}$")
SAFE_TABLE = re.compile(r"^[a-z0-9_]{1,64}$")


def _table_prefix(name: str, ending: str) -> str | None:
    low = (name or "").lower()
    if not low.endswith(ending) or len(low) <= len(ending):
        return None
    base = low[: -len(ending)]
    pref = base if base.endswith("_") else base + "_"
    return pref if TABLE_PREFIX.fullmatch(pref) else None


def _row_table_name(row: dict) -> str:
    for key in ("t", "T", "table_name", "TABLE_NAME", "Tables_in"):
        if key in row and row[key]:
            return str(row[key]).lower()
    for key, val in row.items():
        if val and str(key).lower().startswith("tables_in"):
            return str(val).lower()
    return ""


def _table_alive(db_url: str, table: str) -> bool:
    if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", table or ""):
        return False
    try:
        from app.eliot_company_db import run_select
        run_select(db_url, f"SELECT 1 AS ok FROM {table} LIMIT 1")
        return True
    except Exception:
        return False


def is_custom_shop(names: set[str]) -> bool:
    """Tienda PHP a medida (orders + chat/products), no WordPress/Presta."""
    if any(n.endswith("_posts") or n.endswith("_wc_orders") for n in names):
        return False
    if any(n.startswith("ps_") and n.endswith("orders") for n in names):
        return False
    return "orders" in names and ("chat_conversations" in names or "products" in names)


def table_columns(db_url: str, table: str) -> set[str]:
    if not SAFE_TABLE.fullmatch(table or ""):
        return set()
    try:
        from app.eliot_company_db import run_select
        rows = run_select(
            db_url,
            "SELECT column_name AS c FROM information_schema.columns "
            f"WHERE table_schema = DATABASE() AND table_name = '{table}'",
        )
    except Exception:
        return set()
    out: set[str] = set()
    for r in rows:
        c = str(r.get("c") or r.get("C") or r.get("COLUMN_NAME") or "").lower()
        if COL_NAME.fullmatch(c):
            out.add(c)
    return out


def _pick_col(cols: set[str], *candidates: str) -> str | None:
    for c in candidates:
        if c in cols:
            return c
    return None


def _watchers_custom(db_url: str, prefix: str) -> list[dict]:
    """Vigilantes según columnas reales de una tienda a medida."""
    p = prefix[:5]
    ocols = table_columns(db_url, "orders")
    idf = _pick_col(ocols, "id", "order_id") or "id"
    status = _pick_col(ocols, "status", "order_status", "state")
    pay_status = _pick_col(ocols, "payment_status", "pay_status")
    when = _pick_col(ocols, "created_at", "updated_at", "paid_at", "date")
    out: list[dict] = []

    stuck_sql = None
    if "paid_at" in ocols and "shipped_at" in ocols:
        stuck_sql = (
            f"SELECT {idf} AS id FROM orders WHERE paid_at IS NOT NULL AND shipped_at IS NULL "
            f"AND paid_at < (NOW() - INTERVAL 2 HOUR) ORDER BY paid_at ASC LIMIT 20"
        )
    elif status and when:
        stuck_sql = (
            f"SELECT {idf} AS id FROM orders WHERE {status} IN "
            f"('paid','processing','pagado','procesando','active','completado_pago') "
            f"AND {status} NOT IN ('shipped','delivered','cancelled','canceled','refunded','failed','fallido') "
            f"AND {when} < (NOW() - INTERVAL 2 HOUR) ORDER BY {when} ASC LIMIT 20"
        )
    if stuck_sql:
        out.append({
            "id": "pedidos", "nombre": "Vigilante de pedidos", "capacidad": "orders", "sql": stuck_sql,
            "nivel": "urgente", "clave": "pedidos_atascados", "ref_prefix": f"{p}-ORD-", "id_field": "id",
            "titulo": "Hay pedidos pagados sin completar",
            "propuesta": "Revisalos en el panel de la tienda y avisa a los clientes.",
        })

    fail_sql = None
    if status and when:
        fail_sql = (
            f"SELECT {idf} AS id FROM orders WHERE {status} IN "
            f"('failed','payment_failed','fallido','error','declined') "
            f"AND {when} >= (CURDATE() - INTERVAL 2 DAY) ORDER BY {when} DESC LIMIT 20"
        )
    elif pay_status and when:
        fail_sql = (
            f"SELECT {idf} AS id FROM orders WHERE {pay_status} IN "
            f"('failed','declined','fallido') "
            f"AND {when} >= (CURDATE() - INTERVAL 2 DAY) ORDER BY {when} DESC LIMIT 20"
        )
    if fail_sql:
        out.append({
            "id": "pagos", "nombre": "Vigilante de cobros", "capacidad": "orders", "sql": fail_sql,
            "nivel": "importante", "clave": "pagos_fallidos", "ref_prefix": f"{p}-PAY-", "id_field": "id",
            "titulo": "Hay cobros fallidos recientes",
            "propuesta": "Comprueba la pasarela y el estado del pedido.",
        })

    if _table_alive(db_url, "store_activity_log"):
        lcols = table_columns(db_url, "store_activity_log")
        lid = _pick_col(lcols, "id") or "id"
        lwhen = _pick_col(lcols, "created_at", "updated_at")
        if "resolved_at" in lcols:
            log_sql = f"SELECT {lid} AS id FROM store_activity_log WHERE resolved_at IS NULL ORDER BY {lwhen or lid} DESC LIMIT 20"
        elif _pick_col(lcols, "level", "severity", "type") and lwhen:
            lvl = _pick_col(lcols, "level", "severity", "type")
            log_sql = (
                f"SELECT {lid} AS id FROM store_activity_log WHERE {lvl} IN "
                f"('error','critical','alert','fail','failed') "
                f"AND {lwhen} >= (CURDATE() - INTERVAL 2 DAY) ORDER BY {lwhen} DESC LIMIT 20"
            )
        elif lwhen:
            log_sql = (
                f"SELECT {lid} AS id FROM store_activity_log "
                f"WHERE {lwhen} >= (CURDATE() - INTERVAL 1 DAY) ORDER BY {lwhen} DESC LIMIT 20"
            )
        else:
            log_sql = None
        if log_sql:
            out.append({
                "id": "fallos", "nombre": "Vigilante de fallos", "capacidad": "monitoring", "sql": log_sql,
                "nivel": "importante", "clave": "fallos_abiertos", "ref_prefix": f"{p}-ERR-", "id_field": "id",
                "titulo": "Hay fallos abiertos en la tienda",
                "propuesta": "Revisa el registro de actividad y prioriza lo que afecte a pedidos.",
            })

    if _table_alive(db_url, "chat_conversations"):
        ccols = table_columns(db_url, "chat_conversations")
        cid = _pick_col(ccols, "id", "conversation_id") or "id"
        cst = _pick_col(ccols, "status", "state")
        cup = _pick_col(ccols, "updated_at", "created_at", "last_message_at")
        if cst and cup:
            chat_sql = (
                f"SELECT {cid} AS id FROM chat_conversations WHERE {cst} IN "
                f"('open','waiting','pending','abierto','activo') ORDER BY {cup} DESC LIMIT 20"
            )
        elif cup:
            chat_sql = (
                f"SELECT {cid} AS id FROM chat_conversations "
                f"WHERE {cup} >= (CURDATE() - INTERVAL 1 DAY) ORDER BY {cup} DESC LIMIT 20"
            )
        else:
            chat_sql = f"SELECT {cid} AS id FROM chat_conversations LIMIT 20"
        out.append({
            "id": "chats", "nombre": "Vigilante de atencion", "capacidad": "email", "sql": chat_sql,
            "nivel": "info", "clave": "chats_pendientes", "ref_prefix": f"{p}-MSG-", "id_field": "id",
            "titulo": "Hay chats o tickets abiertos",
            "propuesta": "Responde o cierra lo pendiente en atencion al cliente.",
        })
    return out


def _queries_custom(db_url: str) -> dict:
    ocols = table_columns(db_url, "orders")
    money = _pick_col(ocols, "total", "total_amount", "amount", "grand_total", "importe", "price")
    when = _pick_col(ocols, "created_at", "paid_at", "updated_at", "date")
    status = _pick_col(ocols, "status", "order_status", "state")
    if not money or not when:
        return {}
    where = f"DATE({when})=CURDATE()"
    if status:
        where += f" AND {status} NOT IN ('cancelled','canceled','failed','fallido','refunded')"
    return {
        "ventas": f"SELECT COUNT(*) AS cobros, COALESCE(SUM({money}),0) AS importe_eur FROM orders WHERE {where}"
    }


def _shape_from_names(names: set[str]) -> dict | None:
    for n in names:
        pref = _table_prefix(n, "_wc_orders")
        if pref:
            return {"profile": "woocommerce", "table_prefix": pref, "hpos": True}
    for n in names:
        pref = _table_prefix(n, "_posts")
        if pref:
            return {"profile": "woocommerce", "table_prefix": pref, "hpos": False}
    for n in names:
        pref = _table_prefix(n, "_orders")
        if pref and pref.startswith("ps"):
            return {"profile": "prestashop", "table_prefix": pref, "hpos": False}
    if is_custom_shop(names):
        return {"profile": "custom", "table_prefix": "wp_", "hpos": False}
    return None


def probe_store_shape(db_url: str, hint_prefix: str | None = None) -> dict:
    """Detecta WooCommerce/PrestaShop y el prefijo real de tablas (wp_, xyz_, ps_…)."""
    mysql_default = {
        "profile": "woocommerce",
        "table_prefix": hint_prefix if (hint_prefix and TABLE_PREFIX.fullmatch(hint_prefix)) else "wp_",
        "hpos": False,
    }
    names: set[str] = set()
    try:
        from app.eliot_company_db import list_mysql_tables, run_select
        names = set(list_mysql_tables(db_url))
        if not names:
            rows = run_select(
                db_url,
                "SELECT table_name AS t FROM information_schema.tables "
                "WHERE table_schema = DATABASE() LIMIT 300",
            )
            names = {_row_table_name(r) for r in rows}
            names.discard("")
    except Exception as exc:
        print("store_feed: listado tablas FALLÓ:", type(exc).__name__, flush=True)
    if names:
        print("store_feed: tablas vistas", len(names), flush=True)
    found = _shape_from_names(names)
    if found:
        return found
    prefs = []
    if hint_prefix and TABLE_PREFIX.fullmatch(hint_prefix):
        prefs.append(hint_prefix)
    prefs.extend(["wp_", "wordpress_", "woo_", "shop_", "wc_"])
    seen_pref = set()
    for pref in prefs:
        if pref in seen_pref:
            continue
        seen_pref.add(pref)
        if _table_alive(db_url, f"{pref}wc_orders"):
            return {"profile": "woocommerce", "table_prefix": pref, "hpos": True}
        if _table_alive(db_url, f"{pref}posts"):
            return {"profile": "woocommerce", "table_prefix": pref, "hpos": False}
    if _table_alive(db_url, "ps_orders"):
        return {"profile": "prestashop", "table_prefix": "ps_", "hpos": False}
    # Tiendas Factoría en MySQL suelen ser WooCommerce; generic deja 4 vigilantes en rojo.
    if (db_url or "").startswith(("mysql://", "mysql+", "mariadb://", "mariadb+")):
        return mysql_default
    return {"profile": "generic", "table_prefix": "wp_", "hpos": False}


def score_shape(db_url: str, shape: dict, ref_prefix: str) -> int:
    """Cuántas consultas del perfil responden (sin importar que haya filas)."""
    from app.eliot_company_db import run_select
    watchers = _watchers(
        shape["profile"], ref_prefix,
        table_prefix=shape.get("table_prefix") or "wp_",
        hpos=bool(shape.get("hpos")),
        db_url=db_url,
    )
    ok = 0
    for w in watchers:
        try:
            run_select(db_url, _mysql_intervals(w["sql"]))
            ok += 1
        except Exception:
            continue
    return ok


def resolve_mysql_shape(db_url: str, preferred: str, ref_prefix: str, hint_prefix: str | None = None) -> dict:
    """Elige el perfil/prefijo con más consultas que funcionan.

    Nunca elige «generic» en MySQL de tienda: una tabla orders suelta puede
    ganar con 1 consulta y dejar vigilantes Woo en rojo.
    """
    probed = probe_store_shape(db_url, hint_prefix=hint_prefix)
    tip = probed.get("table_prefix") or hint_prefix or "wp_"
    raw = [
        probed,
        {"profile": "custom", "table_prefix": "wp_", "hpos": False},
        {"profile": "woocommerce", "table_prefix": tip, "hpos": True},
        {"profile": "woocommerce", "table_prefix": tip, "hpos": False},
        {"profile": "woocommerce", "table_prefix": "wp_", "hpos": True},
        {"profile": "woocommerce", "table_prefix": "wp_", "hpos": False},
        {"profile": "prestashop", "table_prefix": "ps_", "hpos": False},
    ]
    if hint_prefix and TABLE_PREFIX.fullmatch(hint_prefix):
        raw.insert(0, {"profile": "woocommerce", "table_prefix": hint_prefix, "hpos": False})
        raw.insert(0, {"profile": "woocommerce", "table_prefix": hint_prefix, "hpos": True})
    if preferred in ("woocommerce", "prestashop", "custom"):
        raw.insert(0, {"profile": preferred, "table_prefix": tip,
                       "hpos": bool(probed.get("hpos")) if preferred == "woocommerce" else False})
    seen, candidates = set(), []
    for shape in raw:
        if shape.get("profile") == "generic":
            continue
        key = (shape["profile"], shape.get("table_prefix"), bool(shape.get("hpos")))
        if key in seen:
            continue
        seen.add(key)
        candidates.append(shape)
    if not candidates:
        return {"profile": "custom" if probed.get("profile") == "custom" else "woocommerce",
                "table_prefix": tip, "hpos": False}
    ranked = []
    for s in candidates:
        sc = score_shape(db_url, s, ref_prefix)
        # Si el listado de tablas dice tienda a medida, preferir custom al empatar.
        bonus = 1 if s["profile"] == "custom" and probed.get("profile") == "custom" else 0
        ranked.append((sc, bonus, s))
    ranked.sort(key=lambda x: (x[0], x[1]), reverse=True)
    best_score, _, best = ranked[0]
    print(
        "store_feed: perfil", best["profile"], "prefijo", best.get("table_prefix"),
        "hpos", bool(best.get("hpos")), "score", best_score, flush=True,
    )
    return best


def _watchers(profile: str, prefix: str, *, table_prefix: str = "wp_", hpos: bool = False,
              db_url: str | None = None) -> list[dict]:
    """Consultas de solo lectura. Si la tienda no tiene esas tablas, ese vigilante queda en silencio."""
    p = prefix[:5]
    tp = table_prefix if TABLE_PREFIX.fullmatch(table_prefix or "") else "wp_"
    if profile == "custom":
        return _watchers_custom(db_url or "", prefix) if db_url else []
    if profile == "woocommerce" and hpos:
        return [
            {
                "id": "pedidos", "nombre": "Vigilante de pedidos", "capacidad": "orders",
                "sql": (f"SELECT o.id AS id FROM {tp}wc_orders o "
                        "WHERE o.type='shop_order' AND o.status IN "
                        "('wc-processing','processing','wc-on-hold','on-hold') "
                        "AND o.date_created_gmt < (UTC_TIMESTAMP() - INTERVAL 2 HOUR) "
                        "ORDER BY o.date_created_gmt ASC LIMIT 20"),
                "nivel": "urgente", "clave": "pedidos_atascados", "ref_prefix": f"{p}-ORD-", "id_field": "id",
                "titulo": "Hay pedidos cobrados sin completar",
                "propuesta": "Revisalos en WooCommerce y avisa al cliente si hace falta.",
            },
            {
                "id": "pagos", "nombre": "Vigilante de cobros", "capacidad": "orders",
                "sql": (f"SELECT o.id AS id FROM {tp}wc_orders o "
                        "WHERE o.type='shop_order' AND o.status IN ('wc-failed','failed') "
                        "AND o.date_created_gmt >= (UTC_TIMESTAMP() - INTERVAL 2 DAY) "
                        "ORDER BY o.date_created_gmt DESC LIMIT 20"),
                "nivel": "importante", "clave": "pagos_fallidos", "ref_prefix": f"{p}-PAY-", "id_field": "id",
                "titulo": "Hay intentos de pago fallidos recientes",
                "propuesta": "Comprueba la pasarela y contacta al cliente si el cobro debe reintentarse.",
            },
            {
                "id": "chats", "nombre": "Vigilante de atencion", "capacidad": "email",
                "sql": (f"SELECT c.comment_ID AS id FROM {tp}comments c "
                        "WHERE c.comment_type='order_note' AND c.comment_approved='0' "
                        "ORDER BY c.comment_date_gmt DESC LIMIT 20"),
                "nivel": "info", "clave": "chats_pendientes", "ref_prefix": f"{p}-MSG-", "id_field": "id",
                "titulo": "Hay notas o mensajes pendientes de revisar",
                "propuesta": "Abre el panel de la tienda y responde o cierra lo pendiente.",
            },
        ]
    if profile == "woocommerce":
        return [
            {
                "id": "pedidos", "nombre": "Vigilante de pedidos", "capacidad": "orders",
                "sql": (f"SELECT p.ID AS id FROM {tp}posts p "
                        "WHERE p.post_type='shop_order' AND p.post_status IN ('wc-processing','wc-on-hold') "
                        "AND p.post_date < (NOW() - INTERVAL 2 HOUR) ORDER BY p.post_date ASC LIMIT 20"),
                "nivel": "urgente", "clave": "pedidos_atascados", "ref_prefix": f"{p}-ORD-", "id_field": "id",
                "titulo": "Hay pedidos cobrados sin completar",
                "propuesta": "Revisalos en WooCommerce y avisa al cliente si hace falta.",
            },
            {
                "id": "pagos", "nombre": "Vigilante de cobros", "capacidad": "orders",
                "sql": (f"SELECT p.ID AS id FROM {tp}posts p "
                        "WHERE p.post_type='shop_order' AND p.post_status='wc-failed' "
                        "AND p.post_date >= (CURDATE() - INTERVAL 2 DAY) ORDER BY p.post_date DESC LIMIT 20"),
                "nivel": "importante", "clave": "pagos_fallidos", "ref_prefix": f"{p}-PAY-", "id_field": "id",
                "titulo": "Hay intentos de pago fallidos recientes",
                "propuesta": "Comprueba la pasarela y contacta al cliente si el cobro debe reintentarse.",
            },
            {
                "id": "chats", "nombre": "Vigilante de atencion", "capacidad": "email",
                "sql": (f"SELECT c.comment_ID AS id FROM {tp}comments c "
                        "WHERE c.comment_type='order_note' AND c.comment_approved='0' "
                        "ORDER BY c.comment_date_gmt DESC LIMIT 20"),
                "nivel": "info", "clave": "chats_pendientes", "ref_prefix": f"{p}-MSG-", "id_field": "id",
                "titulo": "Hay notas o mensajes pendientes de revisar",
                "propuesta": "Abre el panel de la tienda y responde o cierra lo pendiente.",
            },
        ]
    if profile == "prestashop":
        return [
            {
                "id": "pedidos", "nombre": "Vigilante de pedidos", "capacidad": "orders",
                "sql": (f"SELECT o.id_order AS id FROM {tp}orders o "
                        "WHERE o.current_state IN (2,3) AND o.date_add < (NOW() - INTERVAL 2 HOUR) "
                        "ORDER BY o.date_add ASC LIMIT 20"),
                "nivel": "urgente", "clave": "pedidos_atascados", "ref_prefix": f"{p}-ORD-", "id_field": "id",
                "titulo": "Hay pedidos pagados sin enviar",
                "propuesta": "Revisalos en PrestaShop y actualiza el estado.",
            },
            {
                "id": "pagos", "nombre": "Vigilante de cobros", "capacidad": "orders",
                "sql": (f"SELECT o.id_order AS id FROM {tp}orders o "
                        "WHERE o.current_state=8 AND o.date_add >= (CURDATE() - INTERVAL 2 DAY) "
                        "ORDER BY o.date_add DESC LIMIT 20"),
                "nivel": "importante", "clave": "pagos_fallidos", "ref_prefix": f"{p}-PAY-", "id_field": "id",
                "titulo": "Hay pedidos con error de pago",
                "propuesta": "Comprueba el pago y el estado del pedido.",
            },
            {
                "id": "chats", "nombre": "Vigilante de atencion", "capacidad": "email",
                "sql": (f"SELECT m.id_customer_message AS id FROM {tp}customer_message m "
                        "WHERE m.private=0 AND m.date_add >= (CURDATE() - INTERVAL 1 DAY) "
                        "ORDER BY m.date_add DESC LIMIT 20"),
                "nivel": "info", "clave": "chats_pendientes", "ref_prefix": f"{p}-MSG-", "id_field": "id",
                "titulo": "Hay mensajes de clientes de hoy",
                "propuesta": "Revisa la bandeja de PrestaShop y responde.",
            },
        ]
    # generic / PHP / custom shop
    return [
        {
            "id": "pedidos", "nombre": "Vigilante de pedidos", "capacidad": "orders",
            "sql": ("SELECT id FROM orders WHERE paid_at IS NOT NULL AND shipped_at IS NULL "
                    "AND paid_at < CURRENT_TIMESTAMP - INTERVAL '2 hours' ORDER BY paid_at ASC LIMIT 20"),
            "nivel": "urgente", "clave": "pedidos_atascados", "ref_prefix": f"{p}-ORD-", "id_field": "id",
            "titulo": "Hay pedidos pagados sin enviar",
            "propuesta": "Revisalos en el panel de la tienda y avisa a los clientes.",
        },
        {
            "id": "pagos", "nombre": "Vigilante de cobros", "capacidad": "orders",
            "sql": ("SELECT id FROM orders WHERE status IN ('failed','payment_failed') "
                    "AND created_at >= CURRENT_DATE - INTERVAL '2 days' ORDER BY created_at DESC LIMIT 20"),
            "nivel": "importante", "clave": "pagos_fallidos", "ref_prefix": f"{p}-PAY-", "id_field": "id",
            "titulo": "Hay cobros fallidos recientes",
            "propuesta": "Comprueba la pasarela y el estado del pedido.",
        },
        {
            "id": "fallos", "nombre": "Vigilante de fallos", "capacidad": "monitoring",
            "sql": ("SELECT id FROM shop_errors WHERE resolved_at IS NULL "
                    "ORDER BY created_at DESC LIMIT 20"),
            "nivel": "importante", "clave": "fallos_abiertos", "ref_prefix": f"{p}-ERR-", "id_field": "id",
            "titulo": "Hay fallos abiertos en la tienda",
            "propuesta": "Revisa el registro de errores y prioriza los que afectan a pedidos.",
        },
        {
            "id": "chats", "nombre": "Vigilante de atencion", "capacidad": "email",
            "sql": ("SELECT id FROM conversations WHERE status IN ('open','waiting') "
                    "ORDER BY updated_at DESC LIMIT 20"),
            "nivel": "info", "clave": "chats_pendientes", "ref_prefix": f"{p}-MSG-", "id_field": "id",
            "titulo": "Hay chats o tickets abiertos",
            "propuesta": "Responde o cierra lo pendiente en atencion al cliente.",
        },
    ]


def _queries(profile: str, *, table_prefix: str = "wp_", hpos: bool = False, db_url: str | None = None) -> dict:
    tp = table_prefix if TABLE_PREFIX.fullmatch(table_prefix or "") else "wp_"
    if profile == "custom":
        return _queries_custom(db_url) if db_url else {}
    if profile == "woocommerce" and hpos:
        return {
            "ventas": (f"SELECT COUNT(*) AS cobros, COALESCE(SUM(o.total_amount),0) AS importe_eur "
                       f"FROM {tp}wc_orders o WHERE o.type='shop_order' AND o.status IN "
                       "('wc-processing','processing','wc-completed','completed','wc-on-hold','on-hold') "
                       "AND DATE(o.date_created_gmt)=CURDATE()")
        }
    if profile == "woocommerce":
        return {
            "ventas": (f"SELECT COUNT(*) AS cobros, COALESCE(SUM(pm.meta_value),0) AS importe_eur "
                       f"FROM {tp}posts p "
                       f"LEFT JOIN {tp}postmeta pm ON pm.post_id=p.ID AND pm.meta_key='_order_total' "
                       "WHERE p.post_type='shop_order' AND p.post_status IN "
                       "('wc-processing','wc-completed','wc-on-hold') AND DATE(p.post_date)=CURDATE()")
        }
    if profile == "prestashop":
        return {
            "ventas": (f"SELECT COUNT(*) AS cobros, COALESCE(SUM(total_paid_tax_incl),0) AS importe_eur "
                       f"FROM {tp}orders WHERE DATE(date_add)=CURDATE() AND current_state NOT IN (6,7,8)")
        }
    return {
        "ventas": ("SELECT COUNT(*) AS cobros, COALESCE(SUM(total),0) AS importe_eur "
                   "FROM orders WHERE created_at >= CURRENT_DATE AND status NOT IN ('cancelled','failed')")
    }


def _mysql_intervals(sql: str) -> str:
    """Las plantillas genéricas usan sintaxis PostgreSQL; MySQL/MariaDB usan INTERVAL distinto."""
    sql = sql.replace("CURRENT_TIMESTAMP - INTERVAL '2 hours'", "(NOW() - INTERVAL 2 HOUR)")
    sql = sql.replace("CURRENT_DATE - INTERVAL '2 days'", "(CURDATE() - INTERVAL 2 DAY)")
    return sql


def profile_for(organization_id: str, label: str = "") -> str:
    env = (os.getenv("ELIOT_STORE_PROFILE_" + organization_id.replace("-", "_").upper()) or "").strip().lower()
    if env in PROFILES:
        return env
    text = (label or "").lower()
    if "woo" in text:
        return "woocommerce"
    if "presta" in text:
        return "prestashop"
    default = (os.getenv("ELIOT_STORE_PROFILE") or "generic").strip().lower()
    return default if default in PROFILES else "generic"


def _open_password(organization_id: str, cipher: str) -> str | None:
    if not crypto_ready():
        return None
    try:
        raw = unseal(cipher, "company-connector", organization_id)
        data = json.loads(raw.decode())
        password = data.get("password")
        return password if isinstance(password, str) and password else None
    except (StorageCryptoError, json.JSONDecodeError, UnicodeDecodeError, TypeError, AttributeError):
        return None


def _admin_connect():
    url = (os.getenv("DATABASE_URL") or os.getenv("DATABASE_PRIVATE_URL")
           or os.getenv("ELIOT_DATABASE_URL") or "")
    if not url:
        return None
    import psycopg as pg
    try:
        conn = pg.connect(conninfo=url, autocommit=True, connect_timeout=8)
        try:
            conn.execute("SET row_security = off")
        except pg.Error:
            pass
        return conn
    except Exception as exc:
        print("store_feed: conexión admin FALLÓ:", type(exc).__name__, exc, flush=True)
        return None


def load_ftp_host(organization_id: UUID) -> str | None:
    """Host del FTP de la empresa, para sustituir localhost de MySQL desde la nube."""
    conn = _admin_connect()
    if not conn:
        return None
    import psycopg as pg
    try:
        with conn:
            found = conn.execute("SELECT to_regclass('eliot.company_connectors')").fetchone()
            if not found or not found[0]:
                return None
            row = conn.execute(
                """SELECT host FROM eliot.company_connectors
                   WHERE organization_id=%s AND kind = ANY(%s) AND status='configured'
                   ORDER BY updated_at DESC LIMIT 1""",
                (organization_id, ["ftp", "ftps"]),
            ).fetchone()
            return row[0] if row and isinstance(row[0], str) and row[0].strip() else None
    except Exception as exc:
        print("store_feed: lectura FTP FALLÓ:", type(exc).__name__, exc, flush=True)
        return None


def load_store_connector(organization_id: UUID):
    """Lee el primer conector de base configurado de esa empresa (admin, sin RLS)."""
    conn = _admin_connect()
    if not conn:
        return None
    import psycopg as pg
    try:
        with conn:
            found = conn.execute("SELECT to_regclass('eliot.company_connectors')").fetchone()
            if not found or not found[0]:
                return None
            row = conn.execute(
                """SELECT id, kind, label, host, port, username, database_name, secret_cipher, status
                   FROM eliot.company_connectors
                   WHERE organization_id=%s AND kind = ANY(%s) AND status='configured'
                   ORDER BY updated_at DESC LIMIT 1""",
                (organization_id, list(DB_KINDS)),
            ).fetchone()
            if not row:
                return None
            return {
                "id": str(row[0]), "kind": row[1], "label": row[2], "host": row[3], "port": int(row[4]),
                "username": row[5], "database_name": row[6], "secret_cipher": row[7], "status": row[8],
            }
    except Exception as exc:
        print("store_feed: lectura conector FALLÓ:", type(exc).__name__, exc, flush=True)
        return None


def list_store_organizations():
    """Empresas con conector de base listo: [(org_uuid, nombre, feed)]."""
    url = (os.getenv("DATABASE_URL") or os.getenv("DATABASE_PRIVATE_URL")
           or os.getenv("ELIOT_DATABASE_URL") or "")
    if not url or not crypto_ready():
        return []
    import psycopg as pg
    out = []
    try:
        with pg.connect(conninfo=url, autocommit=True, connect_timeout=8) as conn:
            try:
                conn.execute("SET row_security = off")
            except pg.Error:
                pass
            found = conn.execute("SELECT to_regclass('eliot.company_connectors')").fetchone()
            if not found or not found[0]:
                return []
            rows = conn.execute(
                """SELECT DISTINCT ON (c.organization_id) c.organization_id, o.name
                   FROM eliot.company_connectors c
                   JOIN eliot.organizations o ON o.id=c.organization_id
                   WHERE c.kind = ANY(%s) AND c.status='configured'
                   ORDER BY c.organization_id, c.updated_at DESC""",
                (list(DB_KINDS),),
            ).fetchall()
            for org_id, name in rows:
                feed = feed_from_connector(org_id)
                if feed:
                    out.append((str(org_id), name if isinstance(name, str) else "Empresa", feed))
    except Exception as exc:
        print("store_feed: listado FALLÓ:", type(exc).__name__, exc, flush=True)
    return out


def feed_from_connector(organization_id: UUID):
    """Construye un feed kind=database a partir del conector cifrado, o None."""
    from app.eliot_connectors import remote_db_host
    meta = load_store_connector(organization_id)
    if not meta or not meta.get("database_name"):
        return None
    password = _open_password(str(organization_id), meta["secret_cipher"])
    if not password:
        return None
    host = meta["host"]
    ftp_host = load_ftp_host(organization_id)
    if ftp_host:
        host, _ = remote_db_host(host, ftp_host)
    try:
        db_url = build_db_url(meta["kind"], host, meta["port"], meta["username"],
                              password, meta["database_name"])
    except ValueError:
        return None
    profile = profile_for(str(organization_id), meta.get("label") or "")
    prefix = re.sub(r"[^a-z]", "", (meta.get("label") or "tienda").lower())[:4] or "td"
    table_prefix, hpos = "wp_", False
    hint_prefix = None
    label = meta.get("label") or ""
    m = re.search(r"prefix:([A-Za-z0-9_]{1,20})", label)
    if m:
        hint_prefix = m.group(1)
    if meta["kind"] in ("mysql", "mariadb"):
        shape = resolve_mysql_shape(db_url, profile, prefix, hint_prefix=hint_prefix)
        profile = shape["profile"]
        table_prefix = shape["table_prefix"]
        hpos = bool(shape.get("hpos"))
    watchers = _watchers(profile, prefix, table_prefix=table_prefix, hpos=hpos, db_url=db_url)
    if meta["kind"] in ("mysql", "mariadb"):
        for w in watchers:
            w["sql"] = _mysql_intervals(w["sql"])
    slug = re.sub(r"[^a-z0-9-]", "-", (meta.get("label") or "tienda").lower())[:40]
    if not SLUG.fullmatch(slug):
        slug = "tienda"
    return {
        "kind": "database",
        "db_url": db_url,
        "secret": "x" * 32,
        "panel_url": None,
        "watchers": watchers,
        "queries": _queries(profile, table_prefix=table_prefix, hpos=hpos, db_url=db_url),
        "actions": {},
        "empresa": slug,
        "store_profile": profile,
        "table_prefix": table_prefix,
        "hpos": hpos,
        "from_connector": True,
    }
