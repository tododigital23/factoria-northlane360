"""HTTP integration contract: signed JWT -> scoped PostgreSQL query, without real secrets."""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, MagicMock
from uuid import uuid4
from fastapi import FastAPI
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt
from app.organizations_api import router

ISSUER="https://tu-tenant.eu.auth0.com/"
AUDIENCE="https://api.eliot.internal"
KEY=rsa.generate_private_key(public_exponent=65537,key_size=2048)

class JWK:
    key=KEY.public_key()
class FakeJWKS:
    def get_signing_key_from_jwt(self, token): return JWK()

def make_token(subject="auth0|test"):
    now=datetime.now(timezone.utc)
    return jwt.encode(dict(iss=ISSUER,aud=AUDIENCE,sub=subject,scope="read:tasks",iat=now,exp=now+timedelta(minutes=5)),KEY,algorithm="RS256")

def test_http_auth_to_db_context(monkeypatch):
    monkeypatch.setenv("ELIOT_OIDC_ISSUER",ISSUER)
    monkeypatch.setenv("ELIOT_OIDC_AUDIENCE",AUDIENCE)
    for k,v in {"ELIOT_IDENTITY_DB_HOST":"test","ELIOT_IDENTITY_DB_PORT":"5432","ELIOT_IDENTITY_DB_NAME":"eliot_dev","ELIOT_IDENTITY_DB_USER":"eliot_identity_app","ELIOT_IDENTITY_DB_PASSWORD":"test-only"}.items():
        monkeypatch.setenv(k,v)
    organization_id=uuid4()
    cur=MagicMock()
    cur.fetchall.return_value=[(organization_id,"Test Organization","owner")]
    cur.fetchone.return_value=(None,)  # 038 sin instalar: no se filtra nada
    conn=MagicMock()
    conn.__enter__.return_value=conn
    conn.cursor.return_value.__enter__.return_value=cur
    app=FastAPI()
    app.include_router(router)
    with patch("app.organizations_api.jwks_client",return_value=FakeJWKS()),patch("app.organizations_api.psycopg.connect",return_value=conn),patch("app.eliot_readonly.invited_owner",return_value=None):
        response=TestClient(app).get("/v1/me/organizations",headers={"Authorization":"Bearer "+make_token()})
    assert response.status_code==200
    assert response.json()==[{"id":str(organization_id),"name":"Test Organization","role":"owner"}]
    sql_calls=cur.execute.call_args_list
    assert sql_calls[0].args[1]==(ISSUER.rstrip("/")+"|auth0|test",)
    assert "my_organizations()" in sql_calls[1].args[0]

def test_no_token_never_connects_to_database():
    app=FastAPI()
    app.include_router(router)
    with patch("app.organizations_api.psycopg.connect") as connect:
        response=TestClient(app).get("/v1/me/organizations")
    assert response.status_code==401
    connect.assert_not_called()
