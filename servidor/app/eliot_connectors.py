"""Prueba de conectores FTP/FTPS y bases remotas. Las contraseñas llegan ya descifradas solo en memoria."""
from __future__ import annotations

import ftplib
import io
import re
import socket
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from urllib.parse import quote_plus

from app.eliot_company_db import run_select

FTP_KINDS = ("ftp", "ftps")
DB_KINDS = ("mysql", "mariadb", "postgresql", "mssql", "mongodb")
DEFAULT_PORTS = {
    "ftp": 21, "ftps": 21,
    "mysql": 3306, "mariadb": 3306, "postgresql": 5432, "mssql": 1433, "mongodb": 27017,
}
# Keep under browser/proxy limits so Probar always returns JSON instead of NetworkError.
PROBE_SECONDS = 8
FTP_SECONDS = 5
DISCOVER_SECONDS = 18
MAX_WP_CONFIG = 80_000
WP_DEFINE = re.compile(
    r"""define\s*\(\s*['"](DB_NAME|DB_USER|DB_PASSWORD|DB_HOST)['"]\s*,\s*['"]([^'"]*)['"]\s*\)""",
    re.I,
)
WP_TABLE_PREFIX = re.compile(r"""\$table_prefix\s*=\s*['"]([^'"]{1,20})['"]""")
LOCAL_DB_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "localhost:3306"})


def build_db_url(kind: str, host: str, port: int, username: str, password: str, database: str) -> str:
    user = quote_plus(username)
    pwd = quote_plus(password)
    if kind == "postgresql":
        return f"postgresql://{user}:{pwd}@{host}:{port}/{database}?connect_timeout={FTP_SECONDS}"
    if kind in ("mysql", "mariadb"):
        return f"mysql://{user}:{pwd}@{host}:{port}/{database}?connect_timeout={FTP_SECONDS}"
    if kind == "mssql":
        return f"mssql://{user}:{pwd}@{host}:{port}/{database}"
    if kind == "mongodb":
        return f"mongodb://{user}:{pwd}@{host}:{port}/{database}"
    raise ValueError("unsupported database kind")


def _ftp_client(kind: str, host: str, port: int, username: str, password: str, timeout: int) -> ftplib.FTP:
    if kind == "ftps":
        client: ftplib.FTP = ftplib.FTP_TLS(timeout=timeout)
        client.connect(host, port, timeout=timeout)
        client.login(username, password)
        try:
            client.prot_p()
        except ftplib.error_perm:
            pass
        return client
    client = ftplib.FTP(timeout=timeout)
    client.connect(host, port, timeout=timeout)
    client.login(username, password)
    return client


def _ftp_close(client: ftplib.FTP) -> None:
    try:
        client.quit()
    except Exception:
        try:
            client.close()
        except Exception:
            pass


def test_ftp(kind: str, host: str, port: int, username: str, password: str, remote_path: str | None) -> None:
    client = _ftp_client(kind, host, port, username, password, FTP_SECONDS)
    try:
        client.voidcmd("NOOP")
        if remote_path:
            client.cwd(remote_path)
        else:
            client.pwd()
    finally:
        _ftp_close(client)


def parse_wp_config(text: str) -> dict[str, str] | None:
    """Extract DB_* defines and $table_prefix from wp-config.php. Never logs secrets."""
    if not isinstance(text, str) or not text.strip():
        return None
    found: dict[str, str] = {}
    for key, value in WP_DEFINE.findall(text):
        found[key.upper()] = value
    if not found.get("DB_NAME") or not found.get("DB_USER") or not found.get("DB_HOST"):
        return None
    found.setdefault("DB_PASSWORD", "")
    out = {k: found[k] for k in ("DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST")}
    pref = WP_TABLE_PREFIX.search(text)
    if pref and re.fullmatch(r"[A-Za-z0-9_]{1,20}", pref.group(1)):
        out["table_prefix"] = pref.group(1)
    return out


def remote_db_host(db_host: str, ftp_host: str) -> tuple[str, bool]:
    """localhost in wp-config only works on the VPS; from Railway use the FTP host."""
    raw = (db_host or "").strip()
    host_only = raw.split(":")[0].strip().lower()
    if host_only in {"localhost", "127.0.0.1", "::1"} or raw.lower() in LOCAL_DB_HOSTS:
        return ftp_host, True
    return raw.split(":")[0].strip() or ftp_host, False


def wp_config_candidates(remote_path: str | None) -> list[str]:
    """Likely wp-config.php locations relative to the FTP login home."""
    out: list[str] = []
    base = (remote_path or "").strip().strip("/")
    if base:
        out.append(f"{base}/wp-config.php")
        # Login often already lands inside public_html.
        if base.lower().startswith("public_html/"):
            out.append(base.split("/", 1)[1] + "/wp-config.php")
        else:
            out.append(f"public_html/{base}/wp-config.php")
        # Bare folder name if path was nested.
        leaf = base.rsplit("/", 1)[-1]
        if leaf and leaf != base:
            out.append(f"{leaf}/wp-config.php")
            out.append(f"public_html/{leaf}/wp-config.php")
        # WordPress sometimes sits one level above the shop folder.
        if "/" in base:
            parent = base.rsplit("/", 1)[0]
            out.append(f"{parent}/wp-config.php")
            if parent.lower().startswith("public_html/"):
                out.append(parent.split("/", 1)[1] + "/wp-config.php")
            elif parent.lower() != "public_html":
                out.append(f"public_html/{parent}/wp-config.php")
    out.extend([
        "wp-config.php",
        "public_html/wp-config.php",
        "httpdocs/wp-config.php",
        "www/wp-config.php",
        "wordpress/wp-config.php",
    ])
    seen: set[str] = set()
    ordered: list[str] = []
    for path in out:
        key = path.replace("\\", "/").strip("/")
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append(key)
    return ordered


def _retr_text(client: ftplib.FTP, path: str) -> str | None:
    buf = io.BytesIO()
    try:
        client.retrbinary(f"RETR {path}", buf.write)
    except ftplib.all_errors:
        return None
    data = buf.getvalue()
    if not data or len(data) > MAX_WP_CONFIG:
        return None
    return data.decode("utf-8", errors="replace")


def _nlst_names(client: ftplib.FTP, path: str | None = None) -> list[str]:
    try:
        raw = client.nlst(path) if path else client.nlst()
    except ftplib.all_errors:
        return []
    out = []
    for item in raw[:80]:
        if not isinstance(item, str):
            continue
        name = item.replace("\\", "/").rstrip("/")
        if "/" in name:
            name = name.rsplit("/", 1)[-1]
        if name and name not in (".", ".."):
            out.append(name)
    return out


def _find_wp_config_by_listing(client: ftplib.FTP, remote_path: str | None) -> str | None:
    """Scan remote_path (and one level of subdirs) for wp-config.php."""
    roots: list[str | None] = []
    base = (remote_path or "").strip().strip("/") or None
    if base:
        roots.append(base)
        if base.lower().startswith("public_html/"):
            roots.append(base.split("/", 1)[1])
        else:
            roots.append(f"public_html/{base}")
        roots.append(base.rsplit("/", 1)[-1])
    roots.append(None)
    tried: set[str] = set()
    for root in roots:
        key = root or "."
        if key in tried:
            continue
        tried.add(key)
        names = _nlst_names(client, root)
        if "wp-config.php" in names:
            return "wp-config.php" if root is None else f"{root}/wp-config.php"
        for name in names:
            if name.startswith(".") or name.lower().endswith((".jpg", ".png", ".css", ".js", ".txt", ".log")):
                continue
            child = name if root is None else f"{root}/{name}"
            child_names = _nlst_names(client, child)
            if "wp-config.php" in child_names:
                return f"{child}/wp-config.php"
    return None


def _read_wp_config(client: ftplib.FTP, remote_path: str | None) -> str:
    tried = wp_config_candidates(remote_path)
    last_err = "wp-config.php no encontrado"
    for path in tried:
        text = _retr_text(client, path)
        if text and "DB_NAME" in text:
            return text
        if text is None:
            last_err = f"550 {path}: No such file or directory"
    found = _find_wp_config_by_listing(client, remote_path)
    if found:
        text = _retr_text(client, found)
        if text and "DB_NAME" in text:
            return text
        last_err = f"Encontrado {found} pero no se pudo leer"
    sample = ", ".join(tried[:5])
    raise RuntimeError(
        f"No hay wp-config.php en la ruta FTP (probado: {sample}). "
        "Revisa que la ruta remota del FTP apunte a la carpeta de WordPress, "
        "o rellena MySQL a mano desde cPanel."
    )


def discover_wp_database(kind: str, host: str, port: int, username: str, password: str,
                         remote_path: str | None) -> dict:
    """Read WordPress/WooCommerce DB credentials from FTP. Raises RuntimeError on failure."""
    if kind not in FTP_KINDS:
        raise RuntimeError("Solo se puede detectar la base desde un conector FTP/FTPS")
    client = _ftp_client(kind, host, port, username, password, FTP_SECONDS)
    try:
        text = _read_wp_config(client, remote_path)
    finally:
        _ftp_close(client)
    parsed = parse_wp_config(text)
    if not parsed:
        raise RuntimeError("No se pudieron leer DB_NAME/DB_USER/DB_HOST en wp-config.php")
    db_host, adjusted = remote_db_host(parsed["DB_HOST"], host)
    return {
        "kind": "mysql",
        "host": db_host,
        "port": DEFAULT_PORTS["mysql"],
        "username": parsed["DB_USER"],
        "password": parsed["DB_PASSWORD"],
        "database_name": parsed["DB_NAME"],
        "table_prefix": parsed.get("table_prefix") or "wp_",
        "host_adjusted_from_localhost": adjusted,
        "source": "wp-config.php",
    }


def discover_wp_database_bounded(kind: str, host: str, port: int, username: str, password: str,
                                 remote_path: str | None) -> dict | str:
    """Like discover_wp_database but returns an error string on timeout/failure."""
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(discover_wp_database, kind, host, port, username, password, remote_path)
            return future.result(timeout=DISCOVER_SECONDS)
    except FuturesTimeout:
        return ("Tiempo agotado leyendo wp-config por FTP. "
                "Si el hosting bloquea la nube, introduce MySQL a mano desde cPanel.")
    except Exception as exc:
        text = str(exc).strip() or type(exc).__name__
        return text[:220]


def test_database(kind: str, host: str, port: int, username: str, password: str, database: str) -> None:
    url = build_db_url(kind, host, port, username, password, database)
    if kind == "mongodb":
        from pymongo import MongoClient
        client = MongoClient(url, serverSelectionTimeoutMS=FTP_SECONDS * 1000)
        try:
            client.admin.command("ping")
        finally:
            client.close()
        return
    rows = run_select(url, "SELECT 1 AS ok")
    if not rows:
        raise RuntimeError("La base no devolvió resultado de prueba")


def _probe(kind: str, host: str, port: int, username: str, password: str,
           remote_path: str | None, database_name: str | None) -> str | None:
    if kind in FTP_KINDS:
        test_ftp(kind, host, port, username, password, remote_path)
        return None
    if kind in DB_KINDS:
        if not database_name:
            return "Falta el nombre de la base de datos"
        test_database(kind, host, port, username, password, database_name)
        return None
    return "Tipo de conector no soportado"


def test_connector(kind: str, host: str, port: int, username: str, password: str,
                   remote_path: str | None, database_name: str | None) -> str | None:
    """Devuelve None si la prueba va bien, o un mensaje corto si falla.

    Always finishes within PROBE_SECONDS so the browser gets a JSON body
    (long FTP hangs otherwise surface as NetworkError / CORS null).
    """
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(_probe, kind, host, port, username, password, remote_path, database_name)
            return future.result(timeout=PROBE_SECONDS)
    except FuturesTimeout:
        return ("Tiempo agotado: el hosting no responde desde la nube "
                "(firewall/IP). Guarda igual la base MySQL; la prueba en vivo no es obligatoria.")
    except (ftplib.all_errors, socket.timeout, TimeoutError, OSError, RuntimeError, ValueError, ImportError) as exc:
        text = str(exc).strip() or type(exc).__name__
        return text[:220]
    except Exception as exc:
        text = str(exc).strip() or type(exc).__name__
        return text[:220]
