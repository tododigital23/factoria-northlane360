"""Prevent recognizable credentials from leaving Eliot for the model provider."""
from unittest.mock import patch

import pytest
from app.eliot_document_analysis import (
    has_recognizable_credentials,
    generate_document_report,
)

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SOURCE={
    "repository":"tu-organizacion/factoria-northlane360",
    "path":"docs/ARCHITECTURE.md",
    "ref":"feature/auth0-organizations-endpoint",
    "sha":"a"*40,
    "content":"# Plan\nUn servicio multiempresa con auditoría."
}


@pytest.mark.parametrize("content", [
    "-----BEGIN RSA PRIVATE KEY-----\nconfidential\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nconfidential",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nconfidential",
    "github_pat_" + "A"*40,
    "ghp_" + "A"*40,
    "sk-proj-" + "A"*40,
    "AKIA" + "A"*16,
    "Authorization: Bearer " + "a"*60,
    "DATABASE_PASSWORD=" + "my-private-password-secret-is-long",
    "CLIENT_SECRET: " + "a"*30,
])
def test_detects_secret_shapes_without_reproducing_them(content):
    assert has_recognizable_credentials(content)


@pytest.mark.parametrize("content", [
    "# Architecture\nThe application stores a GitHub App ID.",
    "Variable names used: OPENAI_API_KEY, DATABASE_URL and SOME_PASSWORD.",
    "Use SHA references: [L1-L3].",
    "A redacted example: CLIENT_SECRET=<redacted>.",
])
def test_safe_documentation_not_blocked(content):
    assert not has_recognizable_credentials(content)


def test_known_credentials_block_provider_and_token_reservation():
    source={**SOURCE,"content":"Documentation\n" + "ghp_"+"A"*40}
    with patch.dict("os.environ",{"ELIOT_DOCUMENT_ANALYSIS_ENABLED":"true"}), \
        patch("app.eliot_document_analysis.documentary_enabled",return_value=True), \
        patch("app.eliot_document_analysis.reserve_model_request") as budget, \
        patch("app.eliot_document_analysis.urllib.request.urlopen") as network:
        result,reason=generate_document_report(ORG,"Inspect docs",source)
    assert result is None
    assert reason=="source_unavailable"
    budget.assert_not_called()
    network.assert_not_called()


def test_non_secret_document_reaches_existing_budget_gate():
    with patch.dict("os.environ",{"ELIOT_DOCUMENT_ANALYSIS_ENABLED":"true"}), \
        patch("app.eliot_document_analysis.documentary_enabled",return_value=True), \
        patch("app.eliot_document_analysis.reserve_model_request",return_value=False) as budget, \
        patch("app.eliot_document_analysis.urllib.request.urlopen") as network:
        result,reason=generate_document_report(ORG,"Inspect docs",SOURCE)
    assert result is None and reason=="rate_limited"
    budget.assert_called_once()
    network.assert_not_called()
