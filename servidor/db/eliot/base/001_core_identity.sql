-- ELIOT PostgreSQL 18: initial isolated identity and business schema.
-- Run as SET ROLE eliot_migrator in database eliot_dev after review.
CREATE TABLE eliot.organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 180),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE eliot.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 external_subject text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE eliot.organization_memberships (
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 user_id uuid NOT NULL REFERENCES eliot.users(id),
 role text NOT NULL CHECK (role IN ('owner','admin','manager','member','viewer')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,user_id)
);
CREATE INDEX idx_eliot_memberships_user ON eliot.organization_memberships(user_id,organization_id);
ALTER TABLE eliot.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE eliot.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.users FORCE ROW LEVEL SECURITY;
ALTER TABLE eliot.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.organization_memberships FORCE ROW LEVEL SECURITY;
-- No runtime grants or broad policies. All application access fails closed
-- until reviewed identity provisioning and RLS policy migrations.
