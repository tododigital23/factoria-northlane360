import json
from unittest.mock import MagicMock,patch
import urllib.error
from app import eliot_document_analysis as doc

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SOURCE={
 "repository":"tu-organizacion/factoria-northlane360",
 "path":"docs/ARCHITECTURE.md","ref":"feature/auth0-organizations-endpoint",
 "sha":"a"*40,
 "content":"# Diseño\nLos trabajos se auditan.\nNo hay acceso de escritura."
}
VALID_REPORT = """## 1) Alcance y límites
Solo el documento indicado.
## 2) Hechos verificados con citas exactas
El documento menciona auditoría. [L1-L2]
## 3) Posibles riesgos o contradicciones (hipótesis)
Requiere contraste humano.
## 4) Preguntas o archivos adicionales necesarios
¿Qué pruebas respaldan la declaración?
## 5) Recomendaciones para revisión humana (no acciones ejecutadas)
Comprobar la evidencia antes de aceptar.
"""
def fake_provider(text=VALID_REPORT):
    response=MagicMock()
    response.status=200
    response.read.return_value=json.dumps({"status":"completed","output":[
       {"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}],
       "usage":{"input_tokens":150,"output_tokens":50}}).encode()
    response.__enter__.return_value=response
    return response

def test_document_execution_off_even_if_title_executor_enabled():
    with patch.dict("os.environ",{"ELIOT_DOCUMENT_ANALYSIS_ENABLED":"false"}),\
      patch("app.eliot_document_analysis.is_enabled_for",return_value=True),\
      patch("app.eliot_document_analysis.urllib.request.urlopen") as network:
        assert doc.documentary_enabled(ORG) is False
        assert doc.generate_document_report(ORG,"Review",SOURCE)==(None,"provider_error")
    network.assert_not_called()

def test_exact_source_sent_once_no_external_tools_and_line_numbers():
    with patch.dict("os.environ",{
      "ELIOT_DOCUMENT_ANALYSIS_ENABLED":"true","ELIOT_OPENAI_MODEL":"gpt-6-luna",
      "OPENAI_API_KEY":"test-secret-only"},
      clear=True),patch("app.eliot_document_analysis.is_enabled_for",return_value=True),\
      patch("app.eliot_document_analysis.reserve_model_request",return_value=True),\
      patch("app.eliot_document_analysis.record_token_usage") as accounting,\
      patch("app.eliot_document_analysis.urllib.request.urlopen",return_value=fake_provider()) as network:
        report,reason=doc.generate_document_report(ORG,"Review project docs",SOURCE)
    assert reason is None
    assert doc.PREFIX in report and "[L1-L2]" in report
    network.assert_called_once()
    req=network.call_args.args[0]
    body=json.loads(req.data)
    assert body["tools"]==[] and body["store"] is False
    assert body["max_output_tokens"]<=1100
    assert body["input"].find("L2: Los trabajos se auditan.")>0
    assert SOURCE["sha"] in body["input"]
    assert "El documento" not in req.headers.get("Authorization","")
    accounting.assert_called_once()

def test_reject_document_larger_than_bound_without_provider_call():
    with patch.dict("os.environ",{"ELIOT_DOCUMENT_ANALYSIS_ENABLED":"true"}),\
      patch("app.eliot_document_analysis.is_enabled_for",return_value=True),\
      patch("app.eliot_document_analysis.urllib.request.urlopen") as network:
        report,reason=doc.generate_document_report(ORG,"Review",{**SOURCE,"content":"x"*12001})
    assert report is None and reason=="invalid_response"
    network.assert_not_called()

def test_rate_limit_and_http_error_are_safe():
    with patch.dict("os.environ",{"ELIOT_DOCUMENT_ANALYSIS_ENABLED":"true","OPENAI_API_KEY":"test"}),\
      patch("app.eliot_document_analysis.is_enabled_for",return_value=True),\
      patch("app.eliot_document_analysis.reserve_model_request",return_value=False),\
      patch("app.eliot_document_analysis.urllib.request.urlopen") as network:
        assert doc.generate_document_report(ORG,"Review",SOURCE)==(None,"rate_limited")
    network.assert_not_called()


def test_line_citations_accept_single_line_and_inclusive_range():
    assert doc.valid_line_citations("Hallazgo [L1] y [L2-L3]",3)
    assert doc.valid_line_citations("[L1-L3]",3)
    assert doc.valid_line_citations("[L1-3]",3)

def test_line_citations_reject_missing_ambiguous_and_nonexistent():
    for text in (
        "Hallazgos sin referencia",
        "Inexistente [L4]",
        "Rango contrario [L3-L2]",
        "Línea cero [L0]",
        "Letras no válidas [Lone]",
        "Intervalo grande [L1-L999]",
        "Uno válido y otro inválido [L1] [L2-L100]",
        "Formato inválido [L1-]",
    ):
        assert not doc.valid_line_citations(text,3),text

def test_invalid_model_citations_do_not_return_unverifiable_report():
    with patch.dict("os.environ", {
        "ELIOT_DOCUMENT_ANALYSIS_ENABLED":"true",
        "ELIOT_OPENAI_MODEL":"gpt-6-luna",
        "OPENAI_API_KEY":"only-in-test"
    }, clear=True), \
       patch("app.eliot_document_analysis.is_enabled_for",return_value=True), \
       patch("app.eliot_document_analysis.reserve_model_request",return_value=True), \
       patch("app.eliot_document_analysis.record_token_usage"), \
       patch("app.eliot_document_analysis.urllib.request.urlopen",
         return_value=fake_provider("Hallazgo inventado [L44-L50].")):
        output,reason=doc.generate_document_report(ORG,"Review docs",SOURCE)
    assert output is None
    assert reason=="invalid_response"

