from app.eliot_execution_readiness import task_execution_readiness

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TASK={"id":"task1","organization_id":ORG,"status":"pending",
      "assignee_worker_id":"worker1","department_id":"dept1"}
WORKER={"id":"worker1","organization_id":ORG,
        "department_id":"dept1","operating_state":"idle"}

def check(task=TASK,worker=WORKER,**kw):
    return task_execution_readiness(ORG,task,worker,**kw)

def test_complete_readiness_is_advisory_not_permission():
    result=check(document_sha_verified=True,approval_granted=True,
                 durable_budget_enabled=True)
    assert result["ready_for_future_engine"] is True
    assert result["reasons"]==[]
    assert result["advisory_only"] is True
    assert result["execution_started"] is False
    assert result["model_called"] is False
    assert result["github_write_allowed"] is False

def test_no_approval_no_document_no_budget_is_not_ready():
    result=check()
    assert not result["ready_for_future_engine"]
    assert "explicit_approval_required" in result["reasons"]
    assert "durable_budget_unavailable" in result["reasons"]
    assert "document_sha_not_verified" in result["reasons"]

def test_cross_tenant_worker_is_rejected():
    result=check(worker={**WORKER,"organization_id":OTHER},
                 document_sha_verified=True,approval_granted=True,
                 durable_budget_enabled=True)
    assert not result["ready_for_future_engine"]
    assert "worker_tenant_mismatch" in result["reasons"]

def test_unassigned_and_busy_worker_is_rejected():
    result=check(worker={**WORKER,"id":"other","operating_state":"inactive"},
                 document_sha_verified=True,approval_granted=True,
                 durable_budget_enabled=True)
    assert "worker_not_assigned" in result["reasons"]
    assert "worker_not_idle" in result["reasons"]

def test_cross_tenant_task_and_department_mismatch():
    result=check(task={**TASK,"organization_id":OTHER},
                 worker={**WORKER,"department_id":"other"},
                 document_sha_verified=True,approval_granted=True,
                 durable_budget_enabled=True)
    assert "tenant_mismatch" in result["reasons"]
    assert "department_mismatch" in result["reasons"]
