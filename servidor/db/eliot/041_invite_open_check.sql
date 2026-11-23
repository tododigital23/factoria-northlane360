-- 041: ¿sigue viva una invitación de solo consulta? Lo usa el alta de cuentas desde la propia web:
-- solo se puede crear cuenta con una invitación válida, así el registro no queda abierto a cualquiera.
-- Aplicar UNA vez como administrador DESPUÉS de 040, tras pasar el pipeline PG desechable.
--
-- * Devuelve solo sí o no, a partir de la huella del código (un secreto largo e imposible de adivinar).
-- * No dice de qué holding es ni quién la creó, y no la gasta: canjearla sigue siendo cosa de la persona ya identificada.
BEGIN;
SET LOCAL ROLE eliot_migrator;
CREATE FUNCTION eliot.viewer_invite_is_open(p_token_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT p_token_hash ~ '^[0-9a-f]{64}$' AND EXISTS(SELECT 1 FROM eliot.viewer_invites i
  WHERE i.token_hash=p_token_hash AND i.redeemed_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at>clock_timestamp())
$fn$;
REVOKE ALL ON FUNCTION eliot.viewer_invite_is_open(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.viewer_invite_is_open(text) TO eliot_identity;
COMMIT;
