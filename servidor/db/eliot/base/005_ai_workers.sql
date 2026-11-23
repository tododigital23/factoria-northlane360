-- AI worker registry: structural metadata only; no autonomous execution.
CREATE TABLE eliot.ai_workers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 department_id uuid NOT NULL,
 display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
 specialty text NOT NULL CHECK (length(trim(specialty)) BETWEEN 2 AND 160),
 operating_state text NOT NULL DEFAULT 'inactive' CHECK (operating_state IN ('inactive','idle','working','blocked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT fk_ai_workers_department_tenant FOREIGN KEY (department_id, organization_id)
   REFERENCES eliot.departments(id, organization_id),
 CONSTRAINT uq_ai_workers_per_department UNIQUE (department_id,display_name)
);
CREATE INDEX idx_ai_workers_tenant_dept ON eliot.ai_workers(organization_id,department_id);
ALTER TABLE eliot.ai_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_workers FORCE ROW LEVEL SECURITY;
-- Explicitly no policy and no app grants: default-deny until audited API is ready.
