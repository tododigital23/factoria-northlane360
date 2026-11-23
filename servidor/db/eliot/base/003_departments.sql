-- PostgreSQL 18, execute as eliot_migrator in eliot_dev.
CREATE TABLE eliot.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_department_name_per_organization UNIQUE (organization_id,name),
  CONSTRAINT uq_department_id_org UNIQUE (id,organization_id)
);
CREATE INDEX idx_eliot_departments_org ON eliot.departments(organization_id);
ALTER TABLE eliot.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.departments FORCE ROW LEVEL SECURITY;
-- No application access until auth policies and full route checks are tested.
