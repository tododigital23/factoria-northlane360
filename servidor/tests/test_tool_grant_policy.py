from app.eliot_tool_grant_policy import evaluate_github_read_grant

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TASK="77777777-7777-4777-8777-777777777777"
WORKER="55555555-5555-4555-8555-555555555555"
LEASE="11111111-1111-4111-8111-111111111111"
REPO="tu-organizacion/factoria-northlane360"
PATH="docs/ARCHITECTURE.md"
SHA="a"*40

def evaluate(**kwargs):
    grant={
        "organization_id":ORG,"task_id":TASK,"worker_id":WORKER,
        "lease_id":LEASE,"capability":"github_document_read_v1",
        "state":"approved","repository":REPO,"path":PATH,
        "sha":SHA,"read_only":True,"single_use":True
    }
    grant.update(kwargs.pop("grant_changes",{}))
    params={"organization_id":ORG,"task_id":TASK,"worker_id":WORKER,
            "lease_id":LEASE,"grant":grant,"repository":REPO,
            "path":PATH,"sha":SHA}
    params.update(kwargs)
    return evaluate_github_read_grant(**params)

def test_exact_scope_only_advisory_never_calls_github():
    x=evaluate()
    assert x["allowed_by_local_policy"]
    assert x["requires_db_grant_check"]
    assert not x["verified_durable_grant"]
    assert not x["performs_request"]
    assert not x["permits_github_write"]

def test_cross_company_or_task_or_worker_or_lease_rejected():
    for name in ("organization_id","task_id","worker_id","lease_id"):
        x=evaluate(**{name:"other"})
        assert not x["allowed_by_local_policy"]
        assert name+"_mismatch" in x["reasons"]

def test_no_write_no_multiuse_no_unapproved():
    for changes in (
        {"read_only":False},{"single_use":False},
        {"state":"revoked"},{"capability":"github_write"}
    ):
        assert not evaluate(grant_changes=changes)["allowed_by_local_policy"]

def test_reject_path_traversal_and_other_sources():
    for path in ("docs/../secret.txt","docs/.git/config.md",
                 "src/main.py","docs/x.md/../../secret.txt",
                 "docs//README.md","docs/credentials.env"):
        assert not evaluate(path=path,grant_changes={"path":path})["allowed_by_local_policy"]

def test_reject_sha_or_repo_mismatch():
    assert not evaluate(sha="b"*40)["allowed_by_local_policy"]
    assert not evaluate(repository="Other/repo")["allowed_by_local_policy"]
    assert not evaluate(sha="invalid",grant_changes={"sha":"invalid"})["allowed_by_local_policy"]
