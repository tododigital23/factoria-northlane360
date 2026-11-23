-- 026: Owner review of an exact documentary result, with audited task closure.
-- Administrator: apply ONCE in eliot_dev after 025. No provider requests.
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.ai_document_runs ADD CONSTRAINT uq_doc_run_review_scope
 UNIQUE(organization_id,task_id,id);
CREATE TABLE eliot.ai_document_work_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 run_id uuid NOT NULL,
 reviewed_by uuid NOT NULL,
 request_key uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('accepted','changes_requested')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 1000),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 task_status_after text NOT NULL,
 CONSTRAINT fk_work_review_run FOREIGN KEY(organization_id,task_id,run_id)
  REFERENCES eliot.ai_document_runs(organization_id,task_id,id),
 CONSTRAINT fk_work_review_actor FOREIGN KEY(organization_id,reviewed_by)
  REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_work_review_run UNIQUE(organization_id,run_id),
 CONSTRAINT uq_work_review_request UNIQUE(organization_id,request_key),
 CONSTRAINT ck_work_review_status CHECK(
  (decision='accepted' AND task_status_after='completed') OR
  (decision='changes_requested' AND task_status_after='blocked'))
);
CREATE INDEX idx_document_work_reviews_task
 ON eliot.ai_document_work_reviews(organization_id,task_id,reviewed_at DESC);
ALTER TABLE eliot.ai_document_work_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_work_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_work_review_all ON eliot.ai_document_work_reviews
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

-- Private helper reads ALL history. Never use a bounded UI reader for eligibility.
CREATE FUNCTION eliot.document_review_unavailable(p_org uuid,p_task uuid,p_run uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE t eliot.ai_tasks; r eliot.ai_document_runs;
BEGIN
 SELECT * INTO t FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task;
 IF NOT FOUND THEN RETURN 'task_unavailable'; END IF;
 SELECT * INTO r FROM eliot.ai_document_runs WHERE organization_id=p_org AND task_id=p_task AND id=p_run;
 IF NOT FOUND OR r.status IS DISTINCT FROM 'completed' OR r.result_text IS NULL OR r.finished_at IS NULL
 THEN RETURN 'report_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.ai_document_work_reviews WHERE organization_id=p_org AND run_id=p_run)
 THEN RETURN 'already_reviewed'; END IF;
 IF t.status IS DISTINCT FROM 'pending' THEN RETURN 'task_not_pending'; END IF;
 IF t.assignee_worker_id IS DISTINCT FROM r.worker_id OR t.updated_at>r.started_at
 THEN RETURN 'task_changed'; END IF;
 IF eliot.task_has_unconfirmed_execution(p_org,p_task) OR EXISTS(
  SELECT 1 FROM eliot.ai_document_jobs WHERE organization_id=p_org AND task_id=p_task
  AND state IN ('queued','claimed','source_verified','provider_started','needs_review'))
 THEN RETURN 'unconfirmed_execution'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.ai_document_runs WHERE organization_id=p_org AND task_id=p_task
   AND id<>p_run AND started_at>=r.started_at)
 OR EXISTS(SELECT 1 FROM eliot.ai_analysis_runs WHERE organization_id=p_org AND task_id=p_task
   AND started_at>=r.started_at)
 THEN RETURN 'newer_attempt'; END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION eliot.document_review_unavailable(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION eliot.owner_review_document_work(
 p_org uuid,p_task uuid,p_run uuid,p_decision text,p_reason text,p_key uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; saved eliot.ai_document_work_reviews; why text; review_id uuid; after_status text; assignee uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.role='owner' AND m.status='active'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_run IS NULL OR p_key IS NULL OR p_decision IS NULL OR p_decision NOT IN ('accepted','changes_requested')
 OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 1000 THEN
  RAISE EXCEPTION 'Invalid review' USING ERRCODE='22023'; END IF;
 -- Same lock used by runtime run insertion and task mutations. Check uncertainty
 -- before locking a result to avoid waiting on a worker finishing that result.
 SELECT assignee_worker_id INTO assignee FROM eliot.ai_tasks
 WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO saved FROM eliot.ai_document_work_reviews WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF saved.task_id IS DISTINCT FROM p_task OR saved.run_id IS DISTINCT FROM p_run
  OR saved.reviewed_by IS DISTINCT FROM actor OR saved.decision IS DISTINCT FROM p_decision
  OR saved.reason IS DISTINCT FROM trim(p_reason) THEN
   RAISE EXCEPTION 'Conflicting review retry' USING ERRCODE='22023'; END IF;
  RETURN saved.id;
 END IF;
 why:=eliot.document_review_unavailable(p_org,p_task,p_run);
 IF why IS NOT NULL THEN RAISE EXCEPTION 'Review unavailable: %',why USING ERRCODE='55000'; END IF;
 after_status:=CASE p_decision WHEN 'accepted' THEN 'completed' ELSE 'blocked' END;
 INSERT INTO eliot.ai_document_work_reviews(organization_id,task_id,run_id,reviewed_by,request_key,decision,reason,task_status_after)
 VALUES(p_org,p_task,p_run,actor,p_key,p_decision,trim(p_reason),after_status) RETURNING id INTO review_id;
 UPDATE eliot.ai_tasks SET status=after_status,updated_at=clock_timestamp() WHERE organization_id=p_org AND id=p_task;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,assignee,CASE p_decision WHEN 'accepted' THEN 'completed' ELSE 'blocked' END,
  'Owner documentary review '||review_id::text||'; run '||p_run::text||'; '||p_decision||': '||trim(p_reason));
 RETURN review_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_review_document_work(uuid,uuid,uuid,text,text,uuid) FROM PUBLIC;

CREATE FUNCTION eliot.my_document_work_review(p_org uuid,p_task uuid,p_run uuid)
RETURNS TABLE(run_id uuid,task_status text,unavailable_reason text,review_id uuid,
 decision text,reason text,reviewed_at timestamptz,task_status_after text,request_key uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.role='owner' AND m.status='active'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT r.id,t.status,eliot.document_review_unavailable(p_org,p_task,p_run),
  w.id,w.decision,w.reason,w.reviewed_at,w.task_status_after,w.request_key
 FROM eliot.ai_document_runs r JOIN eliot.ai_tasks t ON t.organization_id=r.organization_id AND t.id=r.task_id
 LEFT JOIN eliot.ai_document_work_reviews w ON w.organization_id=r.organization_id AND w.run_id=r.id
 WHERE r.organization_id=p_org AND r.task_id=p_task AND r.id=p_run;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_document_work_review(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_review_document_work(uuid,uuid,uuid,text,text,uuid),
 eliot.my_document_work_review(uuid,uuid,uuid) TO eliot_identity;
COMMIT;
