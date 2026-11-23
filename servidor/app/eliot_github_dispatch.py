"""Bounded document verification. Untrusted repository text never becomes instructions."""
import hashlib
import os
from uuid import UUID

from app.eliot_github_reader import MAX_DOCUMENT_BYTES


def enabled_for(organization_id: UUID) -> bool:
    return (os.getenv("ELIOT_GITHUB_TOOL_ENABLED") == "true"
            and str(organization_id) in {
                item.strip() for item in os.getenv("ELIOT_GITHUB_TOOL_ALLOWED_ORGANIZATIONS", "").split(",")
            })


class InvalidToolDocument(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def verify_document(document: dict, repository: str, path: str, sha: str) -> int:
    if not isinstance(document, dict):
        raise InvalidToolDocument("invalid_document")
    if document.get("repository") != repository or document.get("path") != path:
        raise InvalidToolDocument("invalid_document")
    if document.get("sha") != sha:
        raise InvalidToolDocument("revision_mismatch")
    if (not isinstance(document.get("ref"), str) or not 1 <= len(document["ref"]) <= 300
            or not isinstance(document.get("content"), str)
            or document.get("read_only") is not True
            or document.get("sent_to_model") is not False):
        raise InvalidToolDocument("invalid_document")
    try:
        raw = document["content"].encode("utf-8")
    except UnicodeError:
        raise InvalidToolDocument("invalid_document") from None
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise InvalidToolDocument("invalid_document")
    # Git's blob ID includes the raw byte length and NUL separator.
    header = b"blob " + str(len(raw)).encode("ascii") + bytes([0])
    if hashlib.sha1(header + raw).hexdigest() != sha:
        raise InvalidToolDocument("revision_mismatch")
    return len(raw)
