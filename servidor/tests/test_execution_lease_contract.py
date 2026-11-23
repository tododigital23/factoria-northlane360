"""Static safety contract; PG18 integration is required before deploying migration."""
from pathlib import Path

SQL=Path("db/eliot/020_execution_leases.sql").read_text()

def test_lease_is_unique_per_tenant_task_and_request():
    assert "PRIMARY KEY(organization_id,task_id)" in SQL
    assert "UNIQUE(organization_id,request_key)" in SQL
    assert "FOR UPDATE" in SQL

def test_fail_closed_expired_lease_and_owner_only():
    assert "Previous lease requires manual review" in SQL
    assert "Task already leased" in SQL
    assert "m.role='owner'" in SQL
    assert "app.verified_subject" in SQL

def test_leases_are_not_tool_permissions():
    assert "CREATE FUNCTION eliot.owner_claim_task_lease" in SQL
    assert "CREATE FUNCTION eliot.owner_release_task_lease" in SQL
    assert "CREATE FUNCTION eliot.my_task_execution_lease" in SQL
    assert "ENABLE ROW LEVEL SECURITY" in SQL
    assert "FORCE ROW LEVEL SECURITY" in SQL
    assert "COMMIT;" in SQL
