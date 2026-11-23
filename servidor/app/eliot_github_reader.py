"""Owner-only, company-scoped GitHub App document reader.

No browser-supplied URLs, arbitrary repo access, write methods, tool calls,
model prompts or cross-organization source lookup. No request is made unless
a server-side org/repository mapping and GitHub App credentials are configured.
"""
import base64
import json
import os
import re
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Any

import jwt

API = "https://api.github.com"
MAX_DOCUMENT_BYTES = 16_000
MAX_API_RESPONSE = 160_000
NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
REF = re.compile(r"^[A-Za-z0-9_./-]{1,160}$")
EXTENSIONS = (".md", ".txt", ".rst")


class GitHubSourceError(Exception):
    """Safe, non-secret error for callers; never expose upstream contents."""


class GitHubHTTPError(GitHubSourceError):
    def __init__(self, status: int):
        self.status = int(status)
        super().__init__("GitHub upstream unavailable")


class GitHubConnectionError(GitHubSourceError):
    """One of the fixed, non-secret diagnostic codes only."""
    def __init__(self, code: str):
        self.code = code
        super().__init__("Connection check failed")


def _http_code(status: int) -> str:
    return str(status) if status in (301, 401, 403, 404, 422, 429, 500, 502, 503) else "other"


def _segments(value: str) -> list[str]:
    if not isinstance(value, str) or len(value) > 400:
        raise GitHubSourceError("Invalid document path")
    if "\x00" in value or "\\" in value or "%" in value or "?" in value or "#" in value:
        raise GitHubSourceError("Invalid document path")
    parts = value.split("/")
    if not parts or any(p in ("", ".", "..") for p in parts):
        raise GitHubSourceError("Invalid document path")
    return parts


def _validate_source(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    owner, repo, ref, prefix = (
        item.get("owner"), item.get("repo"), item.get("ref"), item.get("prefix")
    )
    installation = item.get("installation_id")
    if not all(isinstance(x, str) for x in (owner, repo, ref, prefix)):
        return None
    if not NAME.fullmatch(owner) or not NAME.fullmatch(repo) or owner in (".", "..") or repo in (".", ".."):
        return None
    if not REF.fullmatch(ref) or ".." in ref.split("/") or ref.startswith("/"):
        return None
    if not prefix.endswith("/") or not prefix.startswith("docs/"):
        return None
    try:
        _segments(prefix[:-1])
    except GitHubSourceError:
        return None
    # Optional: GitHub's authenticated App API can discover this ID
    # from the exact allowlisted repository. Never accept one from the browser.
    if installation is not None and (type(installation) is not int or installation <= 0):
        return None
    return {
        "owner": owner, "repo": repo, "ref": ref,
        "prefix": prefix, "installation_id": installation
    }


def sources_for(organization_id: str) -> list[dict[str, Any]]:
    """Explicit operator config; every tenant fails closed if missing/malformed."""
    raw = os.getenv("ELIOT_GITHUB_SOURCES_JSON", "")
    if not raw or len(raw) > 30000:
        return []
    try:
        mapping = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(mapping, dict) or not isinstance(mapping.get(organization_id), list):
        return []
    rows = mapping[organization_id][:20]
    sources = [_validate_source(row) for row in rows]
    return [row for row in sources if row is not None]


def configured() -> bool:
    return bool(os.getenv("ELIOT_GITHUB_APP_ID") and
                os.getenv("ELIOT_GITHUB_APP_PRIVATE_KEY"))


def sources_status(organization_id: str, *, check_connection: bool = False) -> dict[str, Any]:
    sources = sources_for(organization_id)
    available = bool(sources and configured())
    result = {
        "organization_id": organization_id,
        "configured": available,
        "read_only": True,
        "external_model_calls": False,
        "connection_checked": check_connection,
        "connected": False,
        "connection_issue": "not_checked" if not check_connection else ("not_configured" if not available else None),
        "repositories": [{
            "full_name": f'{row["owner"]}/{row["repo"]}',
            "prefix": row["prefix"], "ref": row["ref"]
        } for row in sources],
    }
    if not check_connection or not available:
        return result
    # The owner explicitly requested a connection check. Test real GitHub App
    # auth, repo installation and read-only access to approved doc folders.
    # Never return secrets, tokens, raw upstream errors or documents here.
    try:
        for row in sources:
            token = _installation_token(row)
            try:
                listing = _request_json(_contents_url(row, row["prefix"][:-1]), token)
            except GitHubHTTPError as exc:
                raise GitHubConnectionError("docs_http_" + _http_code(exc.status)) from None
            if not isinstance(listing, list):
                raise GitHubConnectionError("docs_not_directory")
        result["connected"] = True
        result["connection_issue"] = None
    except GitHubConnectionError as exc:
        result["connection_issue"] = exc.code
    except GitHubSourceError:
        result["connection_issue"] = "github_request_error"
    return result


def _source_for(organization_id: str, full_name: str) -> dict[str, Any]:
    # The browser may select from the server-side whitelist, never introduce a repo.
    for row in sources_for(organization_id):
        if f'{row["owner"]}/{row["repo"]}'.casefold() == full_name.casefold():
            if not configured():
                raise GitHubSourceError("GitHub source is not configured")
            return row
    raise GitHubSourceError("Repository is not available for this organization")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # Never forward an installation token to another origin.
        return None


def _request_json(url: str, token: str, *, post: dict[str, Any] | None = None) -> Any:
    if not url.startswith(API + "/"):
        raise GitHubSourceError("Invalid GitHub API destination")
    data = None if post is None else json.dumps(post, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "EliotReadOnlyDocs/0.1",
        },
        method="POST" if post is not None else "GET",
    )
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=10) as response:
            if response.status not in (200, 201):
                raise GitHubSourceError("GitHub source unavailable")
            raw = response.read(MAX_API_RESPONSE + 1)
        if len(raw) > MAX_API_RESPONSE:
            raise GitHubSourceError("GitHub response too large")
        return json.loads(raw)
    except urllib.error.HTTPError as exc:
        raise GitHubHTTPError(exc.code) from None
    except (OSError, TimeoutError, ValueError, TypeError):
        raise GitHubSourceError("GitHub source unavailable") from None


def _installation_token(row: dict[str, Any]) -> str:
    try:
        now = int(time.time())
        app_id = str(int(os.environ["ELIOT_GITHUB_APP_ID"]))
        private_key = os.environ["ELIOT_GITHUB_APP_PRIVATE_KEY"].strip()
        # Railway input may contain matching surrounding quotes or escaped
        # newline literals. Normalize only representation, not key material.
        if len(private_key) >= 2 and private_key[0] in ("'", '"') and private_key[-1] == private_key[0]:
            private_key = private_key[1:-1].strip()
        private_key = private_key.replace("\\r\\n", "\n").replace("\\n", "\n")
        if not private_key.startswith(("-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----")):
            raise GitHubConnectionError("pem_missing_private_key_headers")
        if "-----END " not in private_key:
            raise GitHubConnectionError("pem_missing_private_key_footer")
        signed = jwt.encode(
            {"iat": now - 30, "exp": now + 480, "iss": app_id},
            private_key, algorithm="RS256",
        )
    except GitHubConnectionError:
        raise
    except (KeyError, ValueError, TypeError, jwt.PyJWTError):
        raise GitHubConnectionError("pem_signing_failed") from None
    installation_id = row.get("installation_id")
    if installation_id is None:
        # Uses the APP JWT and a fixed allowlisted repository. GitHub resolves
        # only installations of this exact App; browser cannot select an ID.
        owner = urllib.parse.quote(row["owner"], safe="")
        repo = urllib.parse.quote(row["repo"], safe="")
        try:
            discovered = _request_json(
                f"{API}/repos/{owner}/{repo}/installation", signed
            )
        except GitHubHTTPError as exc:
            raise GitHubConnectionError("installation_http_" + _http_code(exc.status)) from None
        except GitHubSourceError:
            raise GitHubConnectionError("installation_network_error") from None
        if not isinstance(discovered, dict):
            raise GitHubConnectionError("installation_response_invalid")
        installation_id = discovered.get("id")
        discovered_app_id = discovered.get("app_id")
        if (type(installation_id) is not int or installation_id <= 0
            or type(discovered_app_id) is not int
            or str(discovered_app_id) != app_id):
            raise GitHubConnectionError("installation_app_id_mismatch")
    try:
        result = _request_json(
            f"{API}/app/installations/{installation_id}/access_tokens",
            signed,
            post={"repositories": [row["repo"]], "permissions": {"contents": "read"}},
        )
    except GitHubHTTPError as exc:
        raise GitHubConnectionError("token_http_" + _http_code(exc.status)) from None
    except GitHubSourceError:
        raise GitHubConnectionError("token_network_error") from None
    token = result.get("token") if isinstance(result, dict) else None
    if not isinstance(token, str) or not token:
        raise GitHubConnectionError("token_response_invalid")
    return token


def _contents_url(row: dict[str, Any], path: str) -> str:
    prefix = f'{API}/repos/{row["owner"]}/{row["repo"]}/contents/'
    return prefix + "/".join(urllib.parse.quote(p, safe="") for p in _segments(path)) + (
        "?ref=" + urllib.parse.quote(row["ref"], safe="")
    )


def list_documents(organization_id: str, repository: str) -> list[dict[str, Any]]:
    row = _source_for(organization_id, repository)
    token = _installation_token(row)
    result = _request_json(_contents_url(row, row["prefix"][:-1]), token)
    if not isinstance(result, list):
        raise GitHubSourceError("Document directory not accessible")
    listed = []
    for item in result:
        if not isinstance(item, dict) or item.get("type") != "file":
            continue
        path, size, sha = item.get("path"), item.get("size"), item.get("sha")
        if not isinstance(path, str) or not path.startswith(row["prefix"]):
            continue
        try:
            parts = _segments(path)
        except GitHubSourceError:
            continue
        if len(parts) != len(_segments(row["prefix"][:-1])) + 1:
            continue
        if not path.casefold().endswith(EXTENSIONS):
            continue
        if type(size) is not int or size < 0 or size > MAX_DOCUMENT_BYTES:
            continue
        if not isinstance(sha, str):
            continue
        listed.append({"path": path, "name": parts[-1], "sha": sha, "size": size})
    return sorted(listed, key=lambda entry: entry["path"])[:50]


def read_document(organization_id: str, repository: str, path: str) -> dict[str, Any]:
    row = _source_for(organization_id, repository)
    _segments(path)
    if not path.startswith(row["prefix"]) or not path.casefold().endswith(EXTENSIONS):
        raise GitHubSourceError("Document outside authorized folder or type")
    token = _installation_token(row)
    result = _request_json(_contents_url(row, path), token)
    if not isinstance(result, dict) or result.get("type") != "file":
        raise GitHubSourceError("Document unavailable")
    if result.get("path") != path or result.get("encoding") != "base64":
        raise GitHubSourceError("Invalid GitHub document")
    size, sha, encoded = result.get("size"), result.get("sha"), result.get("content")
    if type(size) is not int or size > MAX_DOCUMENT_BYTES or size < 0:
        raise GitHubSourceError("Document exceeds size limit")
    if not isinstance(sha, str) or not isinstance(encoded, str):
        raise GitHubSourceError("Invalid GitHub document")
    try:
        content = base64.b64decode("".join(encoded.split()), validate=True)
        if len(content) != size or len(content) > MAX_DOCUMENT_BYTES:
            raise GitHubSourceError("Document size mismatch")
        text = content.decode("utf-8", errors="strict")
    except (ValueError, UnicodeError, TypeError) as exc:
        raise GitHubSourceError("Document is not supported text") from None
    return {
        "repository": repository, "path": path, "ref": row["ref"],
        "sha": sha, "content": text, "source_type": "github",
        "read_only": True, "sent_to_model": False,
    }
