import base64
import json
import os
from unittest.mock import MagicMock, patch
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import eliot_github_reader as reader
from app.organizations_api import router

ORG="11111111-2222-4333-8444-555555555555"
OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
REPO="tu-organizacion/factoria-northlane360"
PATH="docs/ELIOT_HANDOFF.md"
CONFIG=json.dumps({
  ORG: [{"installation_id":12345,"owner":"tu-organizacion",
         "repo":"factoria-northlane360","ref":"main","prefix":"docs/"}],
  OTHER: [{"installation_id":99999,"owner":"AnotherCompany",
           "repo":"private-notes","ref":"main","prefix":"docs/"}]
})
app=FastAPI()
app.include_router(router)
client=TestClient(app)
AUTH={"Authorization":"Bearer fake"}
URL=f"/v1/me/organizations/{ORG}/sources/github"

def conn_for(role="owner"):
    conn=MagicMock()
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchall.return_value=[(UUID(ORG),role)]
    return conn,cur

def test_missing_configuration_fails_closed_without_network():
    with patch.dict(os.environ,{},clear=True),patch.object(reader.urllib.request,"urlopen") as network:
        assert reader.sources_status(ORG)["configured"] is False
        assert reader.sources_for(ORG)==[]
        try:
            reader.list_documents(ORG,REPO)
            assert False
        except reader.GitHubSourceError:
            pass
    network.assert_not_called()

def test_source_scope_is_server_side_by_company():
    with patch.dict(os.environ,{
       "ELIOT_GITHUB_SOURCES_JSON":CONFIG,
       "ELIOT_GITHUB_APP_ID":"100",
       "ELIOT_GITHUB_APP_PRIVATE_KEY":"example"
    },clear=True), patch.object(reader.urllib.request,"urlopen") as network:
        source=reader.sources_status(ORG)
        assert source["configured"] is True
        assert len(source["repositories"])==1
        assert source["repositories"][0]["full_name"]==REPO
        for org,repo in ((ORG,"AnotherCompany/private-notes"),(OTHER,REPO)):
            try:
                reader.list_documents(org,repo)
                assert False
            except reader.GitHubSourceError:
                pass
    network.assert_not_called()

def test_path_traversal_rejected_before_token_or_network():
    with patch.dict(os.environ,{
       "ELIOT_GITHUB_SOURCES_JSON":CONFIG,"ELIOT_GITHUB_APP_ID":"100",
       "ELIOT_GITHUB_APP_PRIVATE_KEY":"example"
    },clear=True), patch.object(reader,"_installation_token") as token:
        for path in ("docs/../.env","README.md","docs/a.py","docs/%2e%2e/config.md",
                     "docs//secret.md","docs\\secret.md"):
            try:
                reader.read_document(ORG,REPO,path)
                assert False, path
            except reader.GitHubSourceError:
                pass
        token.assert_not_called()

def test_list_filters_symlinks_extensions_and_oversized_files():
    data=[
       {"type":"file","path":"docs/README.md","size":100,"sha":"a1"},
       {"type":"file","path":"docs/dev.txt","size":120,"sha":"a2"},
       {"type":"file","path":"docs/.env","size":50,"sha":"a3"},
       {"type":"symlink","path":"docs/alias.md","size":20,"sha":"a4"},
       {"type":"file","path":"docs/huge.md","size":999999,"sha":"a5"},
       {"type":"file","path":"app/secret.md","size":100,"sha":"a6"},
       {"type":"dir","path":"docs/subdir","size":0,"sha":"a7"}
    ]
    with patch.dict(os.environ,{
        "ELIOT_GITHUB_SOURCES_JSON":CONFIG,"ELIOT_GITHUB_APP_ID":"100",
        "ELIOT_GITHUB_APP_PRIVATE_KEY":"example"
    },clear=True),patch.object(reader,"_installation_token",return_value="internal") as token, \
       patch.object(reader,"_request_json",return_value=data) as upstream:
        results=reader.list_documents(ORG,REPO)
    assert [r["path"] for r in results]==["docs/README.md","docs/dev.txt"]
    assert upstream.call_args.args[0].startswith("https://api.github.com/repos/")
    assert upstream.call_args.args[1]=="internal"
    token.assert_called_once()

def test_read_document_returns_sha_and_does_not_send_to_model():
    content="# ELIOT\nDecisiones del proyecto."
    fake={"type":"file","encoding":"base64","size":len(content.encode()),
          "sha":"123abc","path":PATH,
          "content":base64.b64encode(content.encode()).decode()}
    with patch.dict(os.environ,{
        "ELIOT_GITHUB_SOURCES_JSON":CONFIG,"ELIOT_GITHUB_APP_ID":"100",
        "ELIOT_GITHUB_APP_PRIVATE_KEY":"example"
    },clear=True), patch.object(reader,"_installation_token",return_value="internal"), \
         patch.object(reader,"_request_json",return_value=fake):
        result=reader.read_document(ORG,REPO,PATH)
    assert result["content"]==content
    assert result["sha"]=="123abc"
    assert result["sent_to_model"] is False
    assert result["read_only"] is True

def test_unverified_user_rejected_before_db():
    with patch("app.organizations_api.psycopg.connect") as db:
        assert client.get(URL).status_code==401
    db.assert_not_called()

def test_other_org_and_member_blocked_before_github():
    for requested,role,expected in ((OTHER,"owner",404),(ORG,"member",403)):
        db,cur=conn_for(role)
        with patch("app.organizations_api.verified_identity",return_value="issuer|test"), \
          patch("app.organizations_api.db_params",return_value={"host":"db"}), \
          patch("app.organizations_api.psycopg.connect",return_value=db), \
          patch("app.eliot_github_reader._request_json") as network:
            resp=client.get(f"/v1/me/organizations/{requested}/sources/github",headers=AUTH)
        assert resp.status_code==expected
        network.assert_not_called()

def test_owner_status_no_credentials_and_owner_doc_preview():
    db,cur=conn_for()
    with patch.dict(os.environ,{
         "ELIOT_GITHUB_SOURCES_JSON":CONFIG,
         "ELIOT_GITHUB_APP_ID":"100","ELIOT_GITHUB_APP_PRIVATE_KEY":"secret-test"
    },clear=True), patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"db"}), \
         patch("app.organizations_api.psycopg.connect",return_value=db), \
         patch("app.eliot_github_reader.read_document",return_value={
           "repository":REPO,"path":PATH,"content":"safe","sha":"1234",
           "ref":"main","read_only":True,"sent_to_model":False,"source_type":"github"
         }):
        status=client.get(URL,headers=AUTH)
        preview=client.get(URL+"/document",params={"repository":REPO,"path":PATH},headers=AUTH)
    assert status.status_code==200 and status.json()["configured"] is True
    assert preview.status_code==200 and preview.json()["content"]=="safe"
    assert "secret-test" not in status.text and "secret-test" not in preview.text

def test_no_access_to_excluded_path_and_no_db_secrets_leaked():
    db,cur=conn_for()
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"db"}), \
         patch("app.organizations_api.psycopg.connect",return_value=db), \
         patch("app.eliot_github_reader.read_document",side_effect=reader.GitHubSourceError("private")):
        res=client.get(URL+"/document",params={"repository":REPO,"path":"docs/private.md"},headers=AUTH)
    assert res.status_code==404
    assert "private" not in res.text


def test_optional_installation_id_is_resolved_by_app_jwt():
    source = {
        "owner":"tu-organizacion",
        "repo":"factoria-northlane360",
        "ref":"feature/auth0-organizations-endpoint",
        "prefix":"docs/",
    }
    with patch.dict(os.environ,{
         "ELIOT_GITHUB_SOURCES_JSON":json.dumps({ORG:[source]}),
         "ELIOT_GITHUB_APP_ID":"54321",
         "ELIOT_GITHUB_APP_PRIVATE_KEY":"-----BEGIN RSA PRIVATE KEY-----\\nFAKE\\n-----END RSA PRIVATE KEY-----"
        },clear=True), \
         patch("app.eliot_github_reader.jwt.encode",return_value="signed-app-jwt"), \
         patch.object(reader,"_request_json",side_effect=[
            {"id":24680,"app_id":54321},
            {"token":"scoped-installation-token"}
         ]) as calls:
        assert reader.sources_status(ORG)["configured"] is True
        config=reader.sources_for(ORG)
        assert config[0]["installation_id"] is None
        token=reader._installation_token(config[0])
    assert token=="scoped-installation-token"
    assert calls.call_count==2
    assert calls.call_args_list[0].args==(
        "https://api.github.com/repos/tu-organizacion/factoria-northlane360/installation",
        "signed-app-jwt"
    )
    assert calls.call_args_list[1].args==(
        "https://api.github.com/app/installations/24680/access_tokens",
        "signed-app-jwt"
    )
    assert calls.call_args_list[1].kwargs["post"]=={
       "repositories":["factoria-northlane360"],
       "permissions":{"contents":"read"}
    }

def test_discovery_rejects_mismatched_app_id_before_token_issue():
    source = {
       "owner":"tu-organizacion",
       "repo":"factoria-northlane360","ref":"main","prefix":"docs/"
    }
    with patch.dict(os.environ,{
         "ELIOT_GITHUB_SOURCES_JSON":json.dumps({ORG:[source]}),
         "ELIOT_GITHUB_APP_ID":"54321",
         "ELIOT_GITHUB_APP_PRIVATE_KEY":"-----BEGIN RSA PRIVATE KEY-----\\nFAKE\\n-----END RSA PRIVATE KEY-----"
        },clear=True), \
         patch("app.eliot_github_reader.jwt.encode",return_value="signed-app-jwt"), \
         patch.object(reader,"_request_json",return_value={
            "id":24680,"app_id":99999
         }) as calls:
        try:
            reader._installation_token(reader.sources_for(ORG)[0])
            assert False,"Wrong GitHub app accepted"
        except reader.GitHubSourceError:
            pass
    calls.assert_called_once()


def test_live_connection_check_uses_app_credentials_but_returns_no_tokens():
    with patch.dict(os.environ, {
       "ELIOT_GITHUB_SOURCES_JSON":CONFIG,
       "ELIOT_GITHUB_APP_ID":"54321",
       "ELIOT_GITHUB_APP_PRIVATE_KEY":"placeholder"
    },clear=True), \
      patch.object(reader,"_installation_token",return_value="TEMPORARY_SECRET") as token, \
      patch.object(reader,"_request_json",return_value=[]) as upstream:
        result=reader.sources_status(ORG,check_connection=True)
    assert result["configured"] is True
    assert result["connection_checked"] is True
    assert result["connected"] is True
    assert "TEMPORARY_SECRET" not in str(result)
    assert "placeholder" not in str(result)
    token.assert_called_once()
    assert upstream.call_args.args[1] == "TEMPORARY_SECRET"
    assert "/contents/docs?" in upstream.call_args.args[0]


def test_live_connection_check_fails_closed_for_invalid_installation():
    with patch.dict(os.environ,{
       "ELIOT_GITHUB_SOURCES_JSON":CONFIG,
       "ELIOT_GITHUB_APP_ID":"54321",
       "ELIOT_GITHUB_APP_PRIVATE_KEY":"invalid"
    },clear=True), \
      patch.object(reader,"_installation_token",side_effect=reader.GitHubSourceError("private")):
        result=reader.sources_status(ORG,check_connection=True)
    assert result["configured"] is True
    assert result["connected"] is False
    assert "private" not in str(result)


def test_live_connection_check_does_not_contact_github_without_key():
    with patch.dict(os.environ,{
       "ELIOT_GITHUB_SOURCES_JSON":CONFIG,
       "ELIOT_GITHUB_APP_ID":"54321",
    },clear=True), patch.object(reader.urllib.request,"urlopen") as network, \
       patch.object(reader,"_installation_token") as token:
        result=reader.sources_status(ORG,check_connection=True)
    assert result["connection_checked"] is True
    assert result["configured"] is False
    assert result["connected"] is False
    network.assert_not_called()
    token.assert_not_called()


def test_connection_stage_reports_installation_not_found_without_secret():
    with patch.dict(os.environ,{
      "ELIOT_GITHUB_SOURCES_JSON":CONFIG,
      "ELIOT_GITHUB_APP_ID":"5529609",
      "ELIOT_GITHUB_APP_PRIVATE_KEY":"private_test"
    },clear=True),patch.object(reader,"_installation_token",
       side_effect=reader.GitHubConnectionError("installation_http_404")):
        result=reader.sources_status(ORG,check_connection=True)
    assert result["configured"] is True
    assert result["connection_checked"] is True
    assert result["connected"] is False
    assert result["connection_issue"]=="installation_http_404"
    assert "private_test" not in str(result)

def test_connection_stage_reports_docs_permission_failure_without_secret():
    with patch.dict(os.environ,{
      "ELIOT_GITHUB_SOURCES_JSON":CONFIG,
      "ELIOT_GITHUB_APP_ID":"5529609",
      "ELIOT_GITHUB_APP_PRIVATE_KEY":"private_test"
    },clear=True),patch.object(reader,"_installation_token",return_value="PRIVATE_TOKEN"),\
       patch.object(reader,"_request_json",side_effect=reader.GitHubHTTPError(403)):
        result=reader.sources_status(ORG,check_connection=True)
    assert result["connected"] is False
    assert result["connection_issue"]=="docs_http_403"
    assert "PRIVATE_TOKEN" not in str(result)


def test_diagnostic_distinguishes_fingerprint_from_actual_private_key():
    source = {
       "owner":"tu-organizacion","repo":"factoria-northlane360",
       "ref":"main","prefix":"docs/"
    }
    with patch.dict(os.environ,{
        "ELIOT_GITHUB_SOURCES_JSON":json.dumps({ORG:[source]}),
        "ELIOT_GITHUB_APP_ID":"5529609",
        "ELIOT_GITHUB_APP_PRIVATE_KEY":"SHA256:fingerprint-not-a-private-key",
    },clear=True), patch.object(reader,"_request_json") as network:
        result=reader.sources_status(ORG,check_connection=True)
    assert result["connection_issue"]=="pem_missing_private_key_headers"
    assert result["connected"] is False
    network.assert_not_called()
    assert "fingerprint" not in str(result)

def test_pem_text_normalizes_surrounding_quotes_and_literal_newlines():
    key = '"-----BEGIN RSA PRIVATE KEY-----\\nFAKE\\n-----END RSA PRIVATE KEY-----"'
    with patch.dict(os.environ,{
        "ELIOT_GITHUB_APP_ID":"5529609",
        "ELIOT_GITHUB_APP_PRIVATE_KEY":key,
    },clear=True), patch("app.eliot_github_reader.jwt.encode",return_value="signed-jwt") as sign, \
       patch.object(reader,"_request_json",side_effect=[
         {"id":123,"app_id":5529609},{"token":"scoped-token"}
       ]):
        token=reader._installation_token({
            "owner":"tu-organizacion","repo":"factoria-northlane360",
            "ref":"main","prefix":"docs/","installation_id":None
        })
    assert token=="scoped-token"
    assert sign.call_args.args[1].startswith("-----BEGIN RSA PRIVATE KEY-----\n")
    assert sign.call_args.args[1].endswith("\n-----END RSA PRIVATE KEY-----")
