-- 039: observadores de La Factoría (acceso de solo consulta) dados de alta por el propietario con un enlace de invitación.
-- Aplicar UNA vez como administrador DESPUÉS de 038, tras pasar el pipeline PG desechable.
--
-- * El propietario del holding crea una invitación de un solo uso y con caducidad. En la base solo se guarda la huella
--   (SHA-256) del enlace: quien lea la tabla no puede usarlo.
-- * Quien abre el enlace con su propia cuenta queda apuntado como observador de ese holding. El propietario no puede
--   canjear su propia invitación, y una invitación no vale dos veces.
-- * El propietario ve sus observadores e invitaciones pendientes y puede retirar el acceso cuando quiera.
-- * Un observador NO gana ningún permiso aquí: estas tablas solo dicen «a quién representa» cuando consulta. Que no pueda
--   cambiar nada lo impone el servidor (app/eliot_readonly.py), en un único punto.
-- * Todo queda auditado. Sin acceso directo a las tablas: solo por las funciones.
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.holding_audit DROP CONSTRAINT holding_audit_action_check;
ALTER TABLE eliot.holding_audit ADD CONSTRAINT holding_audit_action_check
 CHECK(action IN ('company_provisioned','profile_updated','capability_changed','company_renamed',
  'holding_renamed','storage_connected','storage_disconnected','company_storage_created','company_retired',
  'viewer_invited','viewer_joined','viewer_revoked'));

CREATE TABLE eliot.holding_viewers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 holding_id uuid NOT NULL REFERENCES eliot.holdings(id),
 viewer_subject text NOT NULL CHECK(length(viewer_subject) BETWEEN 3 AND 500),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 invited_by uuid NOT NULL REFERENCES eliot.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz
);
CREATE UNIQUE INDEX holding_viewers_active ON eliot.holding_viewers(viewer_subject) WHERE revoked_at IS NULL;
CREATE TABLE eliot.viewer_invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 holding_id uuid NOT NULL REFERENCES eliot.holdings(id),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 created_by uuid NOT NULL REFERENCES eliot.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 redeemed_at timestamptz,
 cancelled_at timestamptz
);
DO $do$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['holding_viewers','viewer_invites'] LOOP
  EXECUTE format('ALTER TABLE eliot.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE eliot.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY migrator_%I ON eliot.%I FOR ALL TO eliot_migrator USING(true) WITH CHECK(true)',t,t);
 END LOOP; END $do$;

-- El propietario crea una invitación. Como mucho 10 entre observadores activos e invitaciones vivas.
CREATE FUNCTION eliot.owner_create_viewer_invite(p_holding uuid,p_label text,p_token_hash text,p_hours integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_id uuid; v_exp timestamptz; v_label text:=trim(coalesce(p_label,''));
BEGIN
 actor:=eliot.holding_actor(p_holding);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF length(v_label) NOT BETWEEN 1 AND 80 OR v_label ~ '[[:cntrl:]]' OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_hours IS NULL OR p_hours NOT BETWEEN 1 AND 168 THEN
  RAISE EXCEPTION 'Invalid invite' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM eliot.holdings WHERE id=p_holding FOR UPDATE;
 IF (SELECT count(*) FROM eliot.holding_viewers WHERE holding_id=p_holding AND revoked_at IS NULL)
   +(SELECT count(*) FROM eliot.viewer_invites WHERE holding_id=p_holding AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at>clock_timestamp())>=10 THEN
  RAISE EXCEPTION 'Viewer limit reached' USING ERRCODE='55000'; END IF;
 v_exp:=clock_timestamp()+make_interval(hours=>p_hours);
 INSERT INTO eliot.viewer_invites(holding_id,token_hash,label,created_by,expires_at) VALUES(p_holding,p_token_hash,v_label,actor,v_exp) RETURNING id INTO v_id;
 INSERT INTO eliot.holding_audit(holding_id,actor,action,detail) VALUES(p_holding,actor,'viewer_invited',jsonb_build_object('invite_id',v_id,'label',v_label));
 RETURN jsonb_build_object('invite_id',v_id,'holding_id',p_holding,'label',v_label,'expires_at',v_exp,'created',true);
END $fn$;

-- Quien abre el enlace con su cuenta queda como observador. No vale para el propio propietario ni dos veces.
CREATE FUNCTION eliot.redeem_viewer_invite(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_subject text:=NULLIF(current_setting('app.verified_subject',true),''); inv eliot.viewer_invites%ROWTYPE; v_name text;
BEGIN
 IF v_subject IS NULL OR length(v_subject) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO inv FROM eliot.viewer_invites WHERE token_hash=p_token_hash FOR UPDATE;
 IF NOT FOUND OR inv.redeemed_at IS NOT NULL OR inv.cancelled_at IS NOT NULL OR inv.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'Invite not valid' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.holding_owners o JOIN eliot.users u ON u.id=o.user_id WHERE u.external_subject=v_subject) THEN
  RAISE EXCEPTION 'Owners cannot be viewers' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.holding_viewers WHERE viewer_subject=v_subject AND revoked_at IS NULL) THEN
  RAISE EXCEPTION 'Already a viewer' USING ERRCODE='55000'; END IF;
 INSERT INTO eliot.holding_viewers(holding_id,viewer_subject,label,invited_by) VALUES(inv.holding_id,v_subject,inv.label,inv.created_by);
 UPDATE eliot.viewer_invites SET redeemed_at=clock_timestamp() WHERE id=inv.id;
 INSERT INTO eliot.holding_audit(holding_id,actor,action,detail) VALUES(inv.holding_id,inv.created_by,'viewer_joined',jsonb_build_object('invite_id',inv.id,'label',inv.label));
 SELECT name INTO v_name FROM eliot.holdings WHERE id=inv.holding_id;
 RETURN jsonb_build_object('holding_id',inv.holding_id,'holding',v_name,'joined',true);
END $fn$;

-- Lista del propietario: observadores activos e invitaciones todavía vivas. Nunca el enlace ni su huella.
CREATE FUNCTION eliot.owner_viewers(p_holding uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.holding_actor(p_holding) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('holding_id',p_holding,
  'viewers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'label',v.label,'since',v.created_at) ORDER BY v.created_at)
    FROM eliot.holding_viewers v WHERE v.holding_id=p_holding AND v.revoked_at IS NULL),'[]'::jsonb),
  'invites',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'label',i.label,'expires_at',i.expires_at) ORDER BY i.created_at)
    FROM eliot.viewer_invites i WHERE i.holding_id=p_holding AND i.redeemed_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at>clock_timestamp()),'[]'::jsonb));
END $fn$;

-- El propietario retira un observador o anula una invitación pendiente (el mismo botón para los dos).
CREATE FUNCTION eliot.owner_revoke_viewer(p_holding uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_label text; v_kind text;
BEGIN
 actor:=eliot.holding_actor(p_holding);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 UPDATE eliot.holding_viewers SET revoked_at=clock_timestamp() WHERE id=p_id AND holding_id=p_holding AND revoked_at IS NULL RETURNING label INTO v_label;
 IF FOUND THEN v_kind:='viewer';
 ELSE
  UPDATE eliot.viewer_invites SET cancelled_at=clock_timestamp() WHERE id=p_id AND holding_id=p_holding AND redeemed_at IS NULL AND cancelled_at IS NULL RETURNING label INTO v_label;
  IF NOT FOUND THEN RAISE EXCEPTION 'Nothing to revoke' USING ERRCODE='22023'; END IF;
  v_kind:='invite';
 END IF;
 INSERT INTO eliot.holding_audit(holding_id,actor,action,detail) VALUES(p_holding,actor,'viewer_revoked',jsonb_build_object('id',p_id,'label',v_label,'kind',v_kind));
 RETURN jsonb_build_object('holding_id',p_holding,'id',p_id,'kind',v_kind,'revoked',true);
END $fn$;

-- Para el servidor: si quien llama es un observador activo, a qué propietario representa al consultar. NULL si no lo es.
CREATE FUNCTION eliot.my_viewer_owner_subject() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT u.external_subject FROM eliot.holding_viewers v JOIN eliot.holding_owners o ON o.holding_id=v.holding_id JOIN eliot.users u ON u.id=o.user_id
 WHERE v.revoked_at IS NULL AND v.viewer_subject=NULLIF(current_setting('app.verified_subject',true),'')
 ORDER BY (u.id=v.invited_by) DESC,u.created_at LIMIT 1
$fn$;

DO $do$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['eliot.owner_create_viewer_invite(uuid,text,text,integer)','eliot.redeem_viewer_invite(text)','eliot.owner_viewers(uuid)',
  'eliot.owner_revoke_viewer(uuid,uuid)','eliot.my_viewer_owner_subject()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eliot_identity',f);
 END LOOP; END $do$;
COMMIT;
