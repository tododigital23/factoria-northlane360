-- 019: Durable tenant-scoped daily model reservation ledger.
-- APPLY ONCE as DB administrator to eliot_dev after 018.
-- No OpenAI request, secret, prompt or document contents stored.
-- Hard daily ceilings: 30 request reservations and 90000 estimated token units.
-- Safe for concurrent processes: the per-org/day ledger row is locked.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_model_budget_daily (
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 day_utc date NOT NULL,
 calls_reserved integer NOT NULL DEFAULT 0 CHECK (calls_reserved BETWEEN 0 AND 30),
 token_units_reserved integer NOT NULL DEFAULT 0 CHECK (token_units_reserved BETWEEN 0 AND 90000),
 input_tokens_reported bigint NOT NULL DEFAULT 0 CHECK (input_tokens_reported>=0),
 output_tokens_reported bigint NOT NULL DEFAULT 0 CHECK (output_tokens_reported>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id,day_utc)
);
CREATE TABLE eliot.ai_model_budget_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 day_utc date NOT NULL,
 request_key uuid NOT NULL,
 reserved_token_units integer NOT NULL CHECK (reserved_token_units BETWEEN 1 AND 10000),
 input_tokens_reported integer,
 output_tokens_reported integer,
 reserved_at timestamptz NOT NULL DEFAULT now(),
 reconciled_at timestamptz,
 CONSTRAINT fk_model_budget_ledger FOREIGN KEY (organization_id,day_utc)
   REFERENCES eliot.ai_model_budget_daily(organization_id,day_utc),
 CONSTRAINT uq_model_budget_request UNIQUE(organization_id,request_key),
 CONSTRAINT ck_model_budget_reconciled CHECK (
  (input_tokens_reported IS NULL AND output_tokens_reported IS NULL AND reconciled_at IS NULL)
  OR (input_tokens_reported BETWEEN 0 AND 1000000 AND
      output_tokens_reported BETWEEN 0 AND 1000000 AND reconciled_at IS NOT NULL)
 )
);
CREATE INDEX idx_model_reservation_org_day
 ON eliot.ai_model_budget_reservations(organization_id,day_utc,reserved_at DESC);
ALTER TABLE eliot.ai_model_budget_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_model_budget_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_model_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_model_budget_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_budget_daily_all ON eliot.ai_model_budget_daily
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);
CREATE POLICY migrator_budget_reservation_all ON eliot.ai_model_budget_reservations
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_reserve_model_budget(
 p_org uuid,p_key uuid,p_estimate integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_day date := (now() AT TIME ZONE 'UTC')::date;
 v_saved record;
 v_totals record;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=v_subject
 ) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_key IS NULL OR p_estimate IS NULL OR p_estimate NOT BETWEEN 1 AND 10000 THEN
  RAISE EXCEPTION 'Invalid model reservation' USING ERRCODE='22023';
 END IF;
 -- Create the per-company/day row at most once, then lock it to
 -- serialize all callers across replicas. No provider calls happen here.
 INSERT INTO eliot.ai_model_budget_daily(organization_id,day_utc)
 VALUES(p_org,v_day) ON CONFLICT DO NOTHING;
 SELECT calls_reserved,token_units_reserved INTO v_totals
 FROM eliot.ai_model_budget_daily
 WHERE organization_id=p_org AND day_utc=v_day FOR UPDATE;

 SELECT reserved_token_units INTO v_saved
 FROM eliot.ai_model_budget_reservations
 WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF v_saved.reserved_token_units<>p_estimate THEN
    RAISE EXCEPTION 'Conflicting budget reservation retry' USING ERRCODE='22023';
  END IF;
  RETURN true;
 END IF;

 IF v_totals.calls_reserved>=30 OR v_totals.token_units_reserved+p_estimate>90000 THEN
  RETURN false;
 END IF;
 INSERT INTO eliot.ai_model_budget_reservations(
  organization_id,day_utc,request_key,reserved_token_units
 ) VALUES(p_org,v_day,p_key,p_estimate);
 UPDATE eliot.ai_model_budget_daily
 SET calls_reserved=calls_reserved+1,
     token_units_reserved=token_units_reserved+p_estimate,
     updated_at=now()
 WHERE organization_id=p_org AND day_utc=v_day;
 RETURN true;
END
$fn$;

CREATE FUNCTION eliot.owner_reconcile_model_budget(
 p_org uuid,p_key uuid,p_input integer,p_output integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_saved record;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=v_subject
 ) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_key IS NULL OR p_input IS NULL OR p_output IS NULL
 OR p_input NOT BETWEEN 0 AND 1000000 OR p_output NOT BETWEEN 0 AND 1000000 THEN
  RAISE EXCEPTION 'Invalid model usage' USING ERRCODE='22023';
 END IF;
 SELECT day_utc,input_tokens_reported,output_tokens_reported INTO v_saved
 FROM eliot.ai_model_budget_reservations
 WHERE organization_id=p_org AND request_key=p_key FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Reservation unavailable' USING ERRCODE='22023';
 END IF;
 IF v_saved.input_tokens_reported IS NOT NULL THEN
  IF v_saved.input_tokens_reported<>p_input OR
     v_saved.output_tokens_reported<>p_output THEN
    RAISE EXCEPTION 'Conflicting usage reconciliation' USING ERRCODE='22023';
  END IF;
  RETURN false;
 END IF;
 UPDATE eliot.ai_model_budget_reservations
 SET input_tokens_reported=p_input,output_tokens_reported=p_output,
     reconciled_at=now()
 WHERE organization_id=p_org AND request_key=p_key;
 UPDATE eliot.ai_model_budget_daily SET
  input_tokens_reported=input_tokens_reported+p_input,
  output_tokens_reported=output_tokens_reported+p_output,
  updated_at=now()
 WHERE organization_id=p_org AND day_utc=v_saved.day_utc;
 RETURN true;
END
$fn$;

CREATE FUNCTION eliot.my_model_budget_status(p_org uuid)
RETURNS TABLE(
 day_utc date,calls_reserved integer,token_units_reserved integer,
 input_tokens_reported bigint,output_tokens_reported bigint,
 calls_limit integer,token_units_limit integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT (now() AT TIME ZONE 'UTC')::date,
  COALESCE(b.calls_reserved,0)::integer,COALESCE(b.token_units_reserved,0)::integer,
  COALESCE(b.input_tokens_reported,0)::bigint,
  COALESCE(b.output_tokens_reported,0)::bigint,30::integer,90000::integer
 FROM (SELECT 1) sentinel
 LEFT JOIN eliot.ai_model_budget_daily b
 ON b.organization_id=p_org AND b.day_utc=(now() AT TIME ZONE 'UTC')::date
 WHERE EXISTS(
  SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 )
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_reserve_model_budget(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_reconcile_model_budget(uuid,uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_model_budget_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_reserve_model_budget(uuid,uuid,integer) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_reconcile_model_budget(uuid,uuid,integer,integer) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_model_budget_status(uuid) TO eliot_identity;
COMMIT;
