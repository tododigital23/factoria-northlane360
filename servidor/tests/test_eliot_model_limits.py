from unittest.mock import patch

from app.eliot_model_limits import (
    local_usage_snapshot,record_token_usage,reserve_model_request
)
from app.eliot_llm_optional import generate

BASE=1800000000.0

def test_minute_limit_per_tenant(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_MAX_CALLS_PER_MINUTE","2")
    monkeypatch.setenv("ELIOT_OPENAI_MAX_CALLS_PER_DAY","10")
    assert reserve_model_request("test-tenant-minute-A",now=BASE)
    assert reserve_model_request("test-tenant-minute-A",now=BASE+1)
    assert not reserve_model_request("test-tenant-minute-A",now=BASE+2)
    assert reserve_model_request("test-tenant-minute-B",now=BASE+2)
    assert reserve_model_request("test-tenant-minute-A",now=BASE+61)

def test_daily_limit_per_tenant_and_reset(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_MAX_CALLS_PER_MINUTE","20")
    monkeypatch.setenv("ELIOT_OPENAI_MAX_CALLS_PER_DAY","2")
    assert reserve_model_request("test-tenant-daily",now=BASE)
    assert reserve_model_request("test-tenant-daily",now=BASE+61)
    assert not reserve_model_request("test-tenant-daily",now=BASE+122)
    assert reserve_model_request("test-tenant-daily",now=BASE+86400)

def test_only_numeric_token_usage_is_aggregated():
    tenant="test-tenant-usage"
    assert reserve_model_request(tenant,now=BASE)
    record_token_usage(tenant,{"usage":{"input_tokens":123,"output_tokens":35}},now=BASE)
    record_token_usage(tenant,{"usage":{"input_tokens":"huge","output_tokens":-99}},now=BASE)
    assert local_usage_snapshot(tenant,now=BASE)=={
        "requests":1,"input_tokens":123,"output_tokens":35
    }

def test_unknown_tenant_denied():
    assert reserve_model_request("",now=BASE) is False

def test_provider_request_not_sent_after_quota_exhausted(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("OPENAI_API_KEY","fake-test-only-key")
    monkeypatch.setenv("ELIOT_OPENAI_MODEL","gpt-6-luna")
    monkeypatch.setenv("ELIOT_OPENAI_MAX_CALLS_PER_MINUTE","1")
    monkeypatch.setenv("ELIOT_OPENAI_MAX_CALLS_PER_DAY","1")
    tenant="test-tenant-provider-cap"
    with patch("app.eliot_model_limits.time.time",return_value=BASE):
        assert reserve_model_request(tenant)
        with patch("app.eliot_llm_optional.urllib.request.urlopen") as remote:
            result=generate("Dame un resumen","Nova Demo",[],[],[],[],tenant_key=tenant)
        assert result is None
        remote.assert_not_called()

def test_explicit_prompt_disclaims_company_shutdown(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("OPENAI_API_KEY","fake-test-only-key")
    monkeypatch.setenv("ELIOT_OPENAI_MODEL","gpt-6-luna")
    import json
    class Response:
        status=200
        def __enter__(self):return self
        def __exit__(self,*args):return False
        def read(self,n):return json.dumps({"status":"completed","output":[
            {"type":"message","role":"assistant","content":[
             {"type":"output_text","text":"Los agentes IA registrados están inactivos."}
            ]}
        ]}).encode("utf-8")
    with patch("app.eliot_llm_optional.urllib.request.urlopen",return_value=Response()) as remote:
        result=generate("¿Cómo va mi empresa?","Nova",[],[],[],[],tenant_key="prompt-facts-A")
    assert "agentes IA" in result
    body=json.loads(remote.call_args.args[0].data.decode())
    assert "no refleja necesariamente ventas" in body["instructions"]
    assert "Nunca digas que la empresa está paralizada" in body["instructions"]
    assert body["store"] is False
    assert body["tools"]==[]
