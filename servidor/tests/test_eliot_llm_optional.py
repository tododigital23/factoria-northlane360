import io
import json
from unittest.mock import patch

from app.eliot_llm_optional import make_evidence, generate, extract_text

DEPTS=[{"id":"dept-A","name":"Desarrollo"}]
WORKERS=[{"department_id":"dept-A","name":"Programador","state":"inactive"}]
TASKS=[{"title":"Revisar estructura","status":"blocked","department_id":"dept-A"}]
ACTIVITY=[{"event_type":"blocked","task_title":"Revisar estructura"}]

def test_disabled_never_reaches_external_model(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY",raising=False)
    monkeypatch.delenv("ELIOT_OPENAI_ENABLED",raising=False)
    with patch("app.eliot_llm_optional.urllib.request.urlopen") as call:
        assert generate("¿Cómo va la empresa?","Nova",DEPTS,WORKERS,TASKS,ACTIVITY) is None
        call.assert_not_called()

def test_action_is_always_deterministic_even_when_enabled(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("OPENAI_API_KEY","testing-not-real")
    with patch("app.eliot_llm_optional.urllib.request.urlopen") as call:
        assert generate("Crea una empresa nueva","Nova",DEPTS,WORKERS,TASKS,ACTIVITY) is None
        call.assert_not_called()

def test_only_whitelisted_fields_leave_backend():
    evidence=make_evidence("Nova", DEPTS,WORKERS,TASKS,ACTIVITY)
    assert evidence["counts_from_bounded_queries"]["task_blocked"]==1
    assert evidence["departments"]==DEPTS
    assert "jwt" not in json.dumps(evidence).lower()
    assert "OPENAI_API_KEY" not in json.dumps(evidence)

def test_request_has_no_tools_and_disables_persistence(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("OPENAI_API_KEY","testing-not-real")
    monkeypatch.setenv("ELIOT_OPENAI_MODEL","gpt-6-luna")
    response={"status":"completed","output":[{"type":"message","role":"assistant",
     "content":[{"type":"output_text","text":"Una tarea bloqueada en Desarrollo."}]}]}
    class FakeResponse:
        status=200
        def __enter__(self):return self
        def __exit__(self,*args):return None
        def read(self,n):return json.dumps(response).encode()
    with patch("app.eliot_llm_optional.urllib.request.urlopen",return_value=FakeResponse()) as call:
        result=generate("¿Cómo va la empresa?","Nova",DEPTS,WORKERS,TASKS,ACTIVITY)
    assert result=="Una tarea bloqueada en Desarrollo."
    body=json.loads(call.call_args.args[0].data.decode())
    assert body["store"] is False
    assert body["tools"]==[]
    assert body["model"]=="gpt-6-luna"
    assert body["max_output_tokens"]<=450
    assert "testing-not-real" not in json.dumps(body)
    assert "Una tarea bloqueada" not in body["input"]

def test_missing_completed_response_falls_back(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("OPENAI_API_KEY","testing-not-real")
    class FakeResponse:
        status=200
        def __enter__(self):return self
        def __exit__(self,*args):return None
        def read(self,n):return json.dumps({"status":"incomplete","output":[]}).encode()
    with patch("app.eliot_llm_optional.urllib.request.urlopen",return_value=FakeResponse()):
        result=generate("¿Cómo va la empresa?","Nova",DEPTS,WORKERS,TASKS,ACTIVITY)
    assert result is None

def test_invalid_model_is_never_requested(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("OPENAI_API_KEY","testing-not-real")
    monkeypatch.setenv("ELIOT_OPENAI_MODEL","arbitrary-unverified-model")
    with patch("app.eliot_llm_optional.urllib.request.urlopen") as call:
        assert generate("Dame un resumen","Nova",DEPTS,WORKERS,TASKS,ACTIVITY) is None
        call.assert_not_called()
