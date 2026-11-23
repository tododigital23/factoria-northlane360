"""Cryptographic JWT tests: generated RSA keys, no Auth0 secrets/network."""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt
import pytest
from fastapi import HTTPException
from app.organizations_api import verified_identity

ISSUER="https://tu-tenant.eu.auth0.com/"
AUDIENCE="https://api.eliot.internal"
KEY=rsa.generate_private_key(public_exponent=65537,key_size=2048)

class FakeSigningKey:
    key=KEY.public_key()
class FakeJWKS:
    def get_signing_key_from_jwt(self,token):
        return FakeSigningKey()

def make_token(**overrides):
    now=datetime.now(timezone.utc)
    claims=dict(iss=ISSUER,aud=AUDIENCE,sub="auth0|demo-person",scope="read:tasks",iat=now,exp=now+timedelta(minutes=5))
    claims.update(overrides)
    return jwt.encode(claims,KEY,algorithm="RS256",headers={"kid":"test-key"})

@pytest.fixture(autouse=True)
def oidc_config(monkeypatch):
    monkeypatch.setenv("ELIOT_OIDC_ISSUER",ISSUER)
    monkeypatch.setenv("ELIOT_OIDC_AUDIENCE",AUDIENCE)
    with patch("app.organizations_api.jwks_client",return_value=FakeJWKS()):
        yield

def test_valid_signed_token():
    assert verified_identity("Bearer "+make_token()) == ISSUER.rstrip("/")+"|auth0|demo-person"

def test_issuer_without_trailing_slash_still_matches_auth0():
    import os
    os.environ["ELIOT_OIDC_ISSUER"] = ISSUER.rstrip("/")
    assert verified_identity("Bearer "+make_token()) == ISSUER.rstrip("/")+"|auth0|demo-person"

def test_quoted_audience_and_issuer_still_match():
    import os
    os.environ["ELIOT_OIDC_ISSUER"] = '"'+ISSUER+'"'
    os.environ["ELIOT_OIDC_AUDIENCE"] = '"'+AUDIENCE+'"'
    assert verified_identity("Bearer "+make_token()) == ISSUER.rstrip("/")+"|auth0|demo-person"

def test_access_without_read_tasks_scope_is_allowed():
    assert verified_identity("Bearer "+make_token(scope="openid profile email"), require_tasks_scope=False) == ISSUER.rstrip("/")+"|auth0|demo-person"

@pytest.mark.parametrize("changes",[
    {"aud":"https://different-api.example"},
    {"iss":"https://different-issuer.example/"},
    {"exp":datetime.now(timezone.utc)-timedelta(hours=1)}
])
def test_invalid_claims_rejected(changes):
    with pytest.raises(HTTPException) as e:
        verified_identity("Bearer "+make_token(**changes))
    assert e.value.status_code==401

def test_modified_signature_rejected():
    token=make_token()
    head,body,signature=token.split(".")
    changed=signature[:-2]+("ab" if signature[-2:]!="ab" else "cd")
    with pytest.raises(HTTPException) as e:
        verified_identity("Bearer "+ ".".join((head,body,changed)))
    assert e.value.status_code==401

def test_no_jwt_algorithm_none_accepted():
    unsigned=jwt.encode({"sub":"auth0|fake","iss":ISSUER,"aud":AUDIENCE},key="",algorithm="none")
    with pytest.raises(HTTPException):
        verified_identity("Bearer "+unsigned)

def test_missing_read_scope_rejected():
    with pytest.raises(HTTPException) as error:
        verified_identity("Bearer "+make_token(scope="openid profile email"))
    assert error.value.status_code == 401
