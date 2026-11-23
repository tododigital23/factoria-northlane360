"""Deterministic documentary checks; no semantic verdict, external I/O or acceptance."""
import re
import unicodedata

# Fail closed for recognizable credentials BEFORE any outbound provider request.
# This is a narrow best-effort pattern screen, not a DLP certification.
_CREDENTIAL_MARKERS = (
    re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9_.-]{24,}\b"),
    re.compile(r"(?im)^\s*(?:[A-Z0-9_]*PASSWORD|[A-Z0-9_]*SECRET|[A-Z0-9_]*API_KEY)\s*[:=]\s*[\"']?[^\s\"']{24,}[\"']?\s*$"),
)


def has_recognizable_credentials(document_text: str) -> bool:
    """Reject known credential shapes without retaining/logging matching text."""
    return any(pattern.search(document_text) is not None for pattern in _CREDENTIAL_MARKERS)


# Validate textual line ranges deterministically. This checks that references
# exist in the reviewed document, not that the model's interpretation is true.
_LINE_CITATION = re.compile(r"\[L([1-9][0-9]*)(?:-L?([1-9][0-9]*))?\]")
# A bracket counts as an attempted line citation only when it starts like one:
# "L"/"l" followed by a digit, space, dash or placeholder, or "línea(s)"/"line(s)".
# Markdown links such as [Leer guía](...) are ordinary text, not citations.
_CITATION_LIKE = re.compile(
    r"\[\s*(?:[Ll](?=[\s\dxXnN\-\u2010-\u2015\u2212])|(?i:l[ií]neas?|lines?)(?=[\s.:\d]))"
    r"[^\]\n]*(?:\]|(?=\n|$))")


_MAX_LINE_NUMBER = 2**63 - 1


def citation_findings(report: str, document_line_count: int | None):
    """Static, content-free diagnosis: (well-formed ranges, malformed, out_of_bounds, reversed)."""
    ranges, malformed, out_of_bounds, reversed_ = [], 0, 0, 0
    for item in _CITATION_LIKE.finditer(report):
        citation = _LINE_CITATION.fullmatch(item.group())
        if citation is None:
            malformed += 1
            continue
        start = int(citation.group(1))
        end = int(citation.group(2) or start)
        if end > _MAX_LINE_NUMBER or start > _MAX_LINE_NUMBER:
            malformed += 1
        elif start > end:
            reversed_ += 1
        elif document_line_count is not None and end > document_line_count:
            out_of_bounds += 1
        else:
            ranges.append((start, end))
    return ranges, malformed, out_of_bounds, reversed_


def citation_issue_counts(report: str, document_line_count: int | None) -> dict[str, int]:
    """Only static reason codes and counts; never report or source text."""
    ranges, malformed, out_of_bounds, reversed_ = citation_findings(report, document_line_count)
    issues = {"malformed": malformed, "out_of_bounds": out_of_bounds, "reversed": reversed_}
    if not ranges and not any(issues.values()):
        issues["missing"] = 1
    return {k: v for k, v in issues.items() if v}


def valid_line_citations(report: str, document_line_count: int) -> bool:
    ranges, malformed, out_of_bounds, reversed_ = citation_findings(report, document_line_count)
    return bool(ranges) and not (malformed or out_of_bounds or reversed_)


_DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"
_CANON_ITEM = re.compile(r"(L)?\s*([1-9][0-9]*)(?:\s*-\s*L?\s*([1-9][0-9]*))?")
_CANON_SPLIT = re.compile(r"\s*(?:,|;|\by\b|\band\b)\s*")
_LINE_WORD = re.compile(r"(?:l[ií]neas?|lines?)\.?\s*")


def canonicalize_citations(report: str) -> str:
    """Rewrite UNAMBIGUOUS citation variants to canonical [Lx]/[Lx-Ly].

    Typographic dashes, inner spaces, lowercase "l", "Línea(s) 3-5" and lists like
    [L3, L7-L9] are rewritten. Anything else is left untouched so that validation
    still rejects it. Bounds/order are never altered here: invalid ranges stay
    visible to the bounds check. Applied only to new provider output before it is
    stored; historical reports are never rewritten.
    """
    def rewrite(match):
        raw = match.group()
        if not raw.endswith("]"):
            return raw
        inner = raw[1:-1].strip()
        for dash in _DASHES:
            inner = inner.replace(dash, "-")
        word = _LINE_WORD.match(inner.casefold())
        if word:
            inner = inner[word.end():]
        else:
            inner = inner.replace("l", "L")
        out = []
        for part in _CANON_SPLIT.split(inner):
            item = _CANON_ITEM.fullmatch(part)
            # Each list item needs its own "L" unless a "línea(s)" word scopes them all.
            if item is None or (not word and item.group(1) is None):
                return raw
            start, end = item.group(2), item.group(3)
            out.append(f"[L{start}]" if end is None or end == start else f"[L{start}-L{end}]")
        return " ".join(out)
    return _CITATION_LIKE.sub(rewrite, report)


# Contract version consumed verbatim by web DocumentReportQuality.tsx: the check ids and
# states are unchanged, so the version stays v1 (see docs/DOCUMENT_CITATIONS_FIX.md).
VERSION = "document_quality_v1"
MAX_STORED_REPORT = 5800
TITLES = (
 "alcance y limites", "hechos verificados con citas exactas",
 "posibles riesgos o contradicciones", "preguntas o archivos adicionales necesarios",
 "recomendaciones para revision humana",
)

def normalized(value):
 return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c))

def sections(body):
 found = []
 offset = 0
 for line in body.splitlines(keepends=True):
  plain = line.strip().strip("*").strip()
  plain = re.sub(r"^#{1,6}\s*", "", plain).strip().strip("*").strip()
  match = re.fullmatch(r"([1-5])[.)]\s+(.+)", plain)
  if match:
   number = int(match[1])
   title = normalized(match[2]).rstrip(":").strip()
   expected = TITLES[number-1]
   if title == expected or (title.startswith(expected + " (") and title.endswith(")")):
    found.append((number, offset, offset + len(line)))
  offset += len(line)
 if [x[0] for x in found] != [1,2,3,4,5]:
  return None
 return [body[item[2]:(found[i+1][1] if i+1<len(found) else len(body))].strip()
         for i,item in enumerate(found)]

def assess_report(report, *, prefix="", document_line_count=None):
 """Only shape/syntax, best-effort secret screen and optional source line bounds.

 The full stored string is measured BEFORE any normalization/truncation. Historical
 reports have no retained source line count: never imply those bounds were checked.
 """
 body = report[len(prefix):] if prefix and report.startswith(prefix) else report
 parts = sections(body)
 # Syntax and bounds are evaluated independently so that a single malformed
 # bracket no longer raises a second, misleading bounds alert (v1 behaviour).
 # A reversed range is invalid for any document, so it stays a syntax failure.
 ranges, malformed, _, reversed_ = citation_findings(body, None)
 syntax_ok = bool(ranges) and not (malformed or reversed_)
 if document_line_count is None:
  bounds = None
 else:
  in_bounds, _, out_of_bounds, _ = citation_findings(body, document_line_count)
  bounds = bool(in_bounds) and not out_of_bounds
 results = [
  ("report_size", 0 < len(report) <= MAX_STORED_REPORT),
  ("required_sections", parts is not None),
  ("nonempty_sections", parts is not None and all(part.strip() for part in parts)),
  ("citation_syntax", syntax_ok),
  ("facts_cited", parts is not None and valid_line_citations(parts[1], 2**63-1)),
  ("source_line_bounds", bounds),
  ("credential_patterns", not has_recognizable_credentials(body)),
  ("control_characters", re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]", report) is None),
 ]
 return {
  "version": VERSION,
  "status": "requires_attention" if any(ok is False for _,ok in results) else "structural_checks_passed",
  "checks": [{"id": key, "state": "not_checked" if ok is None else "passed" if ok else "failed"} for key,ok in results],
  "semantic_correctness_verified": False,
  "source_line_bounds_verified": document_line_count is not None and bounds is True,
  "human_review_required": True,
 }


def extract_document_text(payload):
 """Complete text only, without the conversational extractor's 3200-char cut."""
 if payload.get("status") != "completed" or payload.get("incomplete_details"):
  return None
 output = payload.get("output")
 if not isinstance(output,list):
  return None
 texts=[]
 for item in output:
  if not isinstance(item,dict) or item.get("type") not in ("reasoning","message"):
   return None
  if item.get("status") not in (None,"completed"):
   return None
  if item.get("type")=="reasoning":
   continue
  if item.get("role")!="assistant" or item.get("status") not in (None,"completed"):
   return None
  content=item.get("content")
  if not isinstance(content,list):
   return None
  for part in content:
   if not isinstance(part,dict) or part.get("type")!="output_text" or not isinstance(part.get("text"),str):
    return None
   texts.append(part["text"])
 return "\n".join(texts).strip() or None
