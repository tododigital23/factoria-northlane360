from unittest.mock import patch, MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router, verified_identity

app=FastAPI()
app.include_router(router)
client=TestClient(app)

def test_no_token_is_rejected():
    assert client.get("/v1/me/organizations").status_code==401

def test_invalid_bearer_is_rejected():
    assert client.get("/v1/me/organizations",headers={"Authorization":"Basic dummy"}).status_code==401

def test_identity_is_set_only_after_verification():
    with patch("app.organizations_api.verified_identity",side_effect=Exception("halt")):
        try:
            client.get("/v1/me/organizations", headers={"Authorization":"Bearer opaque"})
        except Exception as error:
            assert str(error)=="halt"
        else:
            assert False

def test_missing_database_config_is_not_exposed(monkeypatch):
    for name in ("ELIOT_IDENTITY_DB_HOST","ELIOT_IDENTITY_DB_PORT","ELIOT_IDENTITY_DB_NAME",
                 "ELIOT_IDENTITY_DB_USER","ELIOT_IDENTITY_DB_PASSWORD"):
        monkeypatch.delenv(name,raising=False)
    with patch("app.organizations_api.verified_identity",return_value="https://issuer|valid"):
        r=client.get("/v1/me/organizations",headers={"Authorization":"Bearer opaque"})
    assert r.status_code==503
    assert "password" not in r.text.lower()

def _orgs(fetchone, fetchall):
    cur=MagicMock();cur.fetchone.side_effect=fetchone;cur.fetchall.side_effect=fetchall
    conn=MagicMock();conn.__enter__.return_value=conn;conn.cursor.return_value.__enter__.return_value=cur
    with patch("app.organizations_api.verified_identity",return_value="s|1"),patch("app.organizations_api.db_params",return_value={}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        return client.get("/v1/me/organizations",headers={"Authorization":"Bearer opaque"}).json(),cur

def test_retired_companies_are_hidden_only_when_migration_038_exists():
    rows=[("a","Nova","owner"),("b","Juguetes Demo","owner")]
    out,cur=_orgs([(None,),("fn",)],[rows])
    assert [o["id"] for o in out]==["a","b"]
    assert not any("FROM eliot.my_retired_companies" in str(c) for c in cur.execute.call_args_list)
    out,_=_orgs([("fn",)],[rows,[("b",)]])
    assert out==[{"id":"a","name":"Nova","role":"owner"}]
