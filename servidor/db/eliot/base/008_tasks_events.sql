-- Tenant-safe task and append-oriented event foundation. No execution or public grants.
-- AI workers must first have an organization-scoped unique key for composite references.
ALTER TABLE eliot.ai_workers ADD CONSTRAINT uq_ai_workers_id_org UNIQUE (id,organization_id);
CREATE TABLE eliot.ai_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 department_id uuid NOT NULL,
 assignee_worker_id uuid,
 title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','running','blocked','completed','failed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT uq_ai_tasks_org_id UNIQUE (id,organization_id),
 CONSTRAINT fk_ai_tasks_department FOREIGN KEY (department_id,organization_id) REFERENCES eliot.departments(id,organization_id),
 CONSTRAINT fk_ai_tasks_assignee FOREIGN KEY (assignee_worker_id,organization_id) REFERENCES eliot.ai_workers(id,organization_id)
);
CREATE INDEX idx_ai_tasks_org_status ON eliot.ai_tasks(organization_id,status);
CREATE INDEX idx_ai_tasks_department ON eliot.ai_tasks(organization_id,department_id);
ALTER TABLE eliot.ai_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_tasks FORCE ROW LEVEL SECURITY;

CREATE TABLE eliot.ai_task_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid,
 event_type text NOT NULL CHECK (event_type IN ('created','assigned','started','progress','blocked','completed','failed','cancelled','reported')),
 message text NOT NULL DEFAULT '' CHECK (length(message)<=4000),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT fk_task_events_task FOREIGN KEY (task_id,organization_id) REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_task_events_worker FOREIGN KEY (worker_id,organization_id) REFERENCES eliot.ai_workers(id,organization_id)
);
CREATE INDEX idx_ai_task_events_org_created ON eliot.ai_task_events(organization_id,created_at DESC);
CREATE INDEX idx_ai_task_events_task_created ON eliot.ai_task_events(task_id,created_at);
ALTER TABLE eliot.ai_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_task_events FORCE ROW LEVEL SECURITY;
-- No runtime grants or policies: deny by default pending audited authorized APIs.
