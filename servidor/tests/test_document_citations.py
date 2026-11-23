"""Regression for the 9/11 real failure: document_quality_failed=citation_syntax,source_line_bounds.

All provider/DB/GitHub I/O is simulated. The real provider output was never retained,
so the reproduction uses the exact failure signature (both checks failed, facts_cited
passed) produced by plausible model outputs: a valid citation in section 2 plus a
Markdown link or a typographic citation variant in another section.
"""
import hashlib
import json
import logging
import re
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest

from app import eliot_document_analysis as doc
from app import eliot_document_quality as quality
from app import eliot_document_worker as worker

ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
# 43 lines, like docs/OBJECTIVE_PLANNING.md blob bf70ac3 used in the real run.
CONTENT = "\n".join(f"Línea sintética {i} del plan." for i in range(1, 44))
SOURCE = {"repository": "tu-organizacion/factoria-northlane360", "path": "docs/OBJECTIVE_PLANNING.md",
          "ref": "feature/auth0-organizations-endpoint", "sha": "b" * 40, "content": CONTENT}
ENV = {"ELIOT_DOCUMENT_ANALYSIS_ENABLED": "true", "ELIOT_OPENAI_MODEL": "simulado", "OPENAI_API_KEY": "solo-test"}


def report(facts="El plan define pasos [L3-L5].", risks="Hipótesis sobre dependencias [L12].", extra=""):
    return f"""## 1) Alcance y límites
Solo el documento indicado.{extra}
## 2) Hechos verificados con citas exactas
{facts}
## 3) Posibles riesgos o contradicciones (hipótesis)
{risks}
## 4) Preguntas o archivos adicionales necesarios
¿Qué evidencia de pruebas existe?
## 5) Recomendaciones para revisión humana (no acciones ejecutadas)
Contrastar con el propietario.
"""


def provider(text, status="completed", **extra):
    response = MagicMock()
    response.status = 200
    response.read.return_value = json.dumps({"status": status, "output": [
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}],
        "usage": {"input_tokens": 900, "output_tokens": 400}, **extra}).encode()
    response.__enter__.return_value = response
    return response


def generate(text, **kw):
    with patch.dict("os.environ", ENV, clear=True), \
            patch("app.eliot_document_analysis.is_enabled_for", return_value=True), \
            patch("app.eliot_document_analysis.reserve_model_request", return_value=True), \
            patch("app.eliot_document_analysis.record_token_usage"), \
            patch("app.eliot_document_analysis.urllib.request.urlopen", return_value=provider(text, **kw)) as net:
        result = doc.generate_document_report(ORG, "Analizar planificación", SOURCE, budget_store=FakeBudget())
    assert net.call_count == 1  # never a hidden retry or repair call
    return result


class FakeBudget:
    def reserve(self, *a): return True, "k"
    def reconcile(self, *a): return True


def failed(text, lines=43):
    return [c["id"] for c in quality.assess_report(text, document_line_count=lines)["checks"] if c["state"] == "failed"]


# Literal copy of the v1 rule (commit d6ae922) used only to prove the reproduction.
_V1_CITATION = re.compile(r"\[L([1-9][0-9]*)(?:-L?([1-9][0-9]*))?\]")
_V1_LIKE = re.compile(r"\[(?:L|l(?=\d))[^\]\n]*(?:\]|(?=\n|$))")


def v1_valid(text, n):
    spans = list(_V1_LIKE.finditer(text))
    if not spans:
        return False
    for item in spans:
        c = _V1_CITATION.fullmatch(item.group())
        if c is None or int(c.group(1)) > int(c.group(2) or c.group(1)) or int(c.group(2) or c.group(1)) > n:
            return False
    return True


def v1_failed(text, n):
    facts = text.split("## 2)")[1].split("## 3)")[0]
    checks = [("citation_syntax", v1_valid(text, 2**63)), ("facts_cited", v1_valid(facts, 2**63)),
              ("source_line_bounds", v1_valid(text, n))]
    return [k for k, ok in checks if not ok]


# --- Reproduction of the v1 signature -------------------------------------------------

@pytest.mark.parametrize("variant", [
    dict(extra=" Ver [Leer la guía](https://example.invalid)."),   # Markdown link starting with L
    dict(risks="Hipótesis sobre dependencias [L12–L14]."),          # en dash outside section 2
    dict(risks="Hipótesis [L12, L20]."),                            # list outside section 2
])
def test_v1_signature_reproduced_and_now_accepted(variant):
    text = report(**variant)
    # Exact production signature under the frozen v1 rule.
    assert v1_failed(text, 43) == ["citation_syntax", "source_line_bounds"]
    out, reason = generate(text)
    assert reason is None and out.startswith(doc.PREFIX)
    assert "–" not in out and "[L12, L20]" not in out


def test_variants_are_stored_in_canonical_form():
    out, reason = generate(report(facts="Pasos definidos [Líneas 3–5] y [l7].", risks="Riesgo [L12; L20-L21]."))
    assert reason is None
    assert "[L3-L5]" in out and "[L7]" in out and "[L12] [L20-L21]" in out
    assert quality.assess_report(out, prefix=doc.PREFIX, document_line_count=43)["status"] == "structural_checks_passed"


# --- Invalid references are still rejected ---------------------------------------------

@pytest.mark.parametrize("facts,expected", [
    ("Hecho [L44].", ["source_line_bounds"]),                       # line does not exist
    ("Hecho [L40-L60].", ["source_line_bounds"]),
    ("Hecho [L9–L3].", ["citation_syntax", "facts_cited"]),                     # reversed, never reordered
    ("Hecho [L3] y [L3, 7].", ["citation_syntax", "facts_cited"]),                 # ambiguous list item
    ("Hecho [L3] y [Lx-Ly].", ["citation_syntax", "facts_cited"]),                 # unfilled placeholder
    ("Hecho [L3-].", ["citation_syntax", "facts_cited"]),
    ("Hecho sin cita.", ["facts_cited"]),
])
def test_invalid_citations_still_fail_closed(facts, expected, caplog):
    text = report(facts=facts)
    with caplog.at_level(logging.INFO, logger="eliot.document_quality"):
        assert generate(text) == (None, "invalid_response")
    assert failed(quality.canonicalize_citations(text)) == expected
    line = caplog.records[-1].getMessage()
    assert line.startswith("document_quality_failed=")
    assert "Hecho" not in line and "Línea sintética" not in line  # no report/source content in logs


def test_syntax_and_bounds_are_diagnosed_independently():
    assert failed(report(risks="Riesgo [L4, foo].")) == ["citation_syntax"]
    assert failed(report(risks="Riesgo [L80].")) == ["source_line_bounds"]
    assert quality.citation_issue_counts(report(risks="[L80] [L9-L2] [L4, foo]"), 43) == {
        "malformed": 1, "out_of_bounds": 1, "reversed": 1}
    assert quality.citation_issue_counts("sin citas", 43) == {"missing": 1}


def test_markdown_links_are_not_citations_but_legacy_rejections_hold():
    assert quality.valid_line_citations("Ver [Leer más](u) y [L1]", 3)
    assert quality.valid_line_citations("[Lista] de [L2-L3]", 3)
    assert not quality.valid_line_citations("[Lone]", 3)            # no citation at all
    assert not quality.valid_line_citations("[L1] [L 2-x]", 3)


def test_partial_or_incomplete_provider_response_is_rejected_once():
    assert generate(report(), status="incomplete") == (None, "invalid_response")
    assert generate(report(), incomplete_details={"reason": "max_output_tokens"}) == (None, "invalid_response")


def test_prompt_states_canonical_citation_format():
    with patch.dict("os.environ", ENV, clear=True), \
            patch("app.eliot_document_analysis.is_enabled_for", return_value=True), \
            patch("app.eliot_document_analysis.reserve_model_request", return_value=True), \
            patch("app.eliot_document_analysis.record_token_usage"), \
            patch("app.eliot_document_analysis.urllib.request.urlopen", return_value=provider(report())) as net:
        doc.generate_document_report(ORG, "x" * 5, SOURCE, budget_store=FakeBudget())
    instructions = json.loads(net.call_args.args[0].data)["instructions"]
    assert "[L4-L7]" in instructions and "guion ASCII" in instructions and "no incluyas enlaces" in instructions


# --- Historical reports are never rewritten ----------------------------------------------

def test_quality_check_of_stored_report_does_not_canonicalize():
    stored = doc.PREFIX + report(risks="Riesgo [L12–L14].")
    result = quality.assess_report(stored, prefix=doc.PREFIX)
    assert result["version"] == "document_quality_v1"  # web contract unchanged
    assert {c["id"]: c["state"] for c in result["checks"]}["citation_syntax"] == "failed"
    assert {c["id"]: c["state"] for c in result["checks"]}["source_line_bounds"] == "not_checked"
    assert result["source_line_bounds_verified"] is False
    canonical_historic = doc.PREFIX + report()
    assert quality.assess_report(canonical_historic, prefix=doc.PREFIX)["status"] == "structural_checks_passed"


# --- Worker path: one claim, one provider call, canonical report persisted ----------------

TEXT = CONTENT + "\n"
SHA = hashlib.sha1(b"blob " + str(len(TEXT.encode())).encode() + b"\0" + TEXT.encode()).hexdigest()
JOB = dict(id=uuid4(), token=uuid4(), title="Analizar planificación", repository=SOURCE["repository"],
           path=SOURCE["path"], ref=SOURCE["ref"], sha=SHA)
DOC = {**{k: JOB[k] for k in ("repository", "path", "ref", "sha")}, "content": TEXT,
       "read_only": True, "sent_to_model": False}


@pytest.mark.parametrize("text,finished_ok", [(report(risks="Riesgo [L12–L14]."), True),
                                              (report(facts="Hecho [L99]."), False)])
def test_worker_persists_canonical_report_or_single_failure(text, finished_ok):
    org = UUID(ORG)
    db = MagicMock()
    db.take.return_value = JOB
    db.call.return_value = (True,)
    db.finish.return_value = "completed" if finished_ok else "failed"
    with patch.dict("os.environ", ENV, clear=True), \
            patch.object(worker, "allowed_organizations", return_value=(org,)), \
            patch.object(worker, "read_document", return_value=DOC), \
            patch("app.eliot_document_analysis.is_enabled_for", return_value=True), \
            patch("app.eliot_document_analysis.reserve_model_request", return_value=True), \
            patch("app.eliot_document_analysis.record_token_usage"), \
            patch("app.eliot_document_analysis.urllib.request.urlopen", return_value=provider(text)) as net:
        worker.process_one(org, db)
    assert net.call_count == 1
    db.finish.assert_called_once()
    _, _, stored, reason = db.finish.call_args.args
    if finished_ok:
        assert reason is None and "[L12-L14]" in stored and "–" not in stored
    else:
        assert stored is None and reason == "invalid_response"
