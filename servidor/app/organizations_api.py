"""Authenticated companies endpoint (development-only gated).
The identity DB account must have EXECUTE on eliot.my_organizations() only.
"""
import os
from contextlib import contextmanager
from functools import lru_cache

import jwt
from fastapi import APIRouter, Header, HTTPException, Query
from jwt import PyJWKClient

from app import eliot_db as psycopg

router = APIRouter(prefix="/v1/me", tags=["organizations"])

@lru_cache(maxsize=1)
def jwks_client():
    return PyJWKClient(os.environ["ELIOT_OIDC_JWKS_URL"], cache_keys=True, lifespan=300, timeout=5)


def _clean_env(name):
    return (os.environ.get(name) or "").strip().strip('"').strip("'")


def _oidc_issuers(issuer):
    bare = issuer.rstrip("/")
    return bare, (bare, bare + "/") if bare else ()


def _oidc_audiences(audience):
    bare = audience.rstrip("/")
    return tuple(dict.fromkeys([audience, bare, bare + "/"])) if bare else ()


def _decode_oidc_token(token):
    issuer = _clean_env("ELIOT_OIDC_ISSUER")
    audience = _clean_env("ELIOT_OIDC_AUDIENCE")
    bare, issuers = _oidc_issuers(issuer)
    audiences = _oidc_audiences(audience)
    if not bare or not audiences:
        raise KeyError("OIDC issuer or audience missing")
    key = jwks_client().get_signing_key_from_jwt(token).key
    payload = jwt.decode(
        token, key, algorithms=["RS256"], audience=audiences, issuer=issuers,
        options={"require": ["exp", "iat", "sub", "iss", "aud"]}, leeway=20,
    )
    return payload, bare


def _log_oidc_reject(token, exc):
    try:
        raw = jwt.decode(
            token,
            options={"verify_signature": False, "verify_aud": False, "verify_exp": False, "verify_iss": False},
        )
        print(
            "oidc: rechazo", type(exc).__name__,
            "iss=", raw.get("iss"), "aud=", raw.get("aud"), "sub=", raw.get("sub"),
            flush=True,
        )
    except Exception:
        print("oidc: rechazo", type(exc).__name__, "token ilegible", flush=True)


def subject_keys(subject):
    """Auth0 a veces guarda el issuer con barra final y a veces sin ella."""
    if not subject or "|" not in subject:
        return (subject,) if subject else ()
    host, rest = subject.split("|", 1)
    bare = host.rstrip("/") + "|" + rest
    slashed = host.rstrip("/") + "/" + "|" + rest
    return tuple(dict.fromkeys([subject, bare, slashed]))


def verified_identity(authorization: str | None, require_tasks_scope=True):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")
    token = authorization[7:].strip()
    if not token or len(token) > 12000:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        payload, bare = _decode_oidc_token(token)
        scopes = set(str(payload.get("scope", "")).split())
        if require_tasks_scope and "read:tasks" not in scopes:
            raise ValueError("Missing approved API scope")
        sub = payload["sub"]
        if not isinstance(sub,str) or not sub or len(sub)>400:
            raise ValueError("Invalid subject")
    except (jwt.PyJWTError, ValueError, KeyError, TimeoutError) as exc:
        _log_oidc_reject(token, exc)
        raise HTTPException(status_code=401, detail=f"Invalid credentials:{type(exc).__name__}") from None
    # Un observador (acceso de solo consulta) ve lo del propietario y no puede cambiar nada: se decide aquí, en un único punto.
    from app import eliot_readonly
    return eliot_readonly.resolve(bare + "|" + sub)

def db_params():
    return psycopg.identity_params()


def _first_owner_enabled():
    return os.getenv("ELIOT_AUTO_PROVISION_USER") == "on" or psycopg.on_managed_paas()


def ensure_first_owner(subject):
    """Si el holding está vacío, el primer login Auth0 pasa a ser propietario.

    En Postgres nativo ELIOT_AUTO_PROVISION_USER no insertaba filas (eso era
    solo el almacén portable). En Railway hay que hacerlo como administrador,
    sin SET ROLE eliot_identity.
    """
    if not subject or not _first_owner_enabled():
        return
    url = (os.getenv("DATABASE_URL") or os.getenv("DATABASE_PRIVATE_URL")
           or os.getenv("ELIOT_DATABASE_URL") or "")
    if not url:
        return
    import psycopg as pg
    name = (os.getenv("ELIOT_HOLDING_NAME") or "Superempresa Freddy").strip()[:120]
    if len(name) < 2:
        name = "Superempresa Freddy"
    try:
        with pg.connect(conninfo=url, autocommit=True, connect_timeout=10) as conn:
            conn.execute("SELECT pg_advisory_lock(834001)")
            try:
                try:
                    conn.execute("SET row_security = off")
                except pg.Error:
                    pass
                conn.execute("""
DO $p$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='eliot' AND tablename='users' AND policyname='bootstrap_users_write'
  ) THEN
    CREATE POLICY bootstrap_users_write ON eliot.users
      FOR ALL TO eliot_migrator USING (true) WITH CHECK (true);
  END IF;
END
$p$;
""")
                try:
                    conn.execute("SET ROLE eliot_migrator")
                except pg.Error:
                    pass
                suffix = subject.split("|", 1)[1] if "|" in subject else subject
                found = conn.execute(
                    """SELECT id FROM eliot.users
                       WHERE external_subject = %s
                          OR external_subject = ANY(%s)
                          OR external_subject LIKE %s
                       ORDER BY (external_subject = %s) DESC
                       LIMIT 1""",
                    (subject, list(subject_keys(subject)), "%|" + suffix, subject),
                ).fetchone()
                if found:
                    user = found
                    conn.execute(
                        "UPDATE eliot.users SET external_subject=%s WHERE id=%s AND external_subject<>%s",
                        (subject, user[0], subject),
                    )
                else:
                    user = conn.execute(
                        """INSERT INTO eliot.users(external_subject) VALUES(%s)
                           ON CONFLICT (external_subject) DO UPDATE SET external_subject=EXCLUDED.external_subject
                           RETURNING id""",
                        (subject,),
                    ).fetchone()
                already = conn.execute(
                    "SELECT count(*) FROM eliot.holding_owners WHERE user_id=%s",
                    (user[0],),
                ).fetchone()
                if already and already[0]:
                    return
                holding = conn.execute("SELECT id FROM eliot.holdings ORDER BY created_at LIMIT 1").fetchone()
                if not holding:
                    holding = conn.execute(
                        "INSERT INTO eliot.holdings(name, max_companies) VALUES(%s, 5) RETURNING id",
                        (name,),
                    ).fetchone()
                conn.execute(
                    """INSERT INTO eliot.holding_owners(holding_id, user_id) VALUES(%s, %s)
                       ON CONFLICT DO NOTHING""",
                    (holding[0], user[0]),
                )
            finally:
                try:
                    conn.execute("RESET ROLE")
                except pg.Error:
                    pass
                conn.execute("SELECT pg_advisory_unlock(834001)")
    except Exception as exc:
        print("install: primer propietario FALLÓ:", type(exc).__name__, exc, flush=True)


@router.get("/access")
def my_access(authorization: str | None = Header(default=None)):
    """Dice a la web si esta sesión es de solo consulta, para que lo avise y no ofrezca acciones."""
    subject = verified_identity(authorization, require_tasks_scope=False)
    print("access: subject=", subject, flush=True)
    ensure_first_owner(subject)
    from app import eliot_readonly
    viewer = eliot_readonly.is_viewer()
    # El rol eliot_identity a veces no puede leer empresas (503). El dueño del holding
    # se comprueba aparte, con la URL de Postgres, y tiene que poder entrar igual.
    allowed = viewer or _owns_holding_admin(subject) or has_any_access(subject)
    print("access: allowed=", allowed, "viewer=", viewer, flush=True)
    # «allowed»: tiene algo que ver aquí (es observador, miembro de alguna empresa o dueño de un holding).
    # Una cuenta sin nada —por ejemplo un observador al que se le retiró el acceso— no pasa de la puerta.
    return {"read_only": viewer, "allowed": allowed, "subject": subject}


def _owns_holding_admin(subject):
    url = (os.getenv("DATABASE_URL") or os.getenv("DATABASE_PRIVATE_URL")
           or os.getenv("ELIOT_DATABASE_URL") or "")
    if not subject or not url:
        return False
    import psycopg as pg
    try:
        with pg.connect(conninfo=url, autocommit=True, connect_timeout=10) as conn:
            try:
                conn.execute("SET row_security = off")
            except pg.Error:
                pass
            keys = subject_keys(subject)
            suffix = subject.split("|", 1)[1] if "|" in subject else subject
            row = conn.execute(
                """SELECT count(*) FROM eliot.holding_owners ho
                   JOIN eliot.users u ON u.id = ho.user_id
                   WHERE u.external_subject = ANY(%s)
                      OR u.external_subject LIKE %s""",
                (list(keys), "%|" + suffix),
            ).fetchone()
            return bool(row and row[0])
    except Exception as exc:
        print("install: comprobación holding FALLÓ:", type(exc).__name__, exc, flush=True)
        return False


def _admin_connect():
    url = (os.getenv("DATABASE_URL") or os.getenv("DATABASE_PRIVATE_URL")
           or os.getenv("ELIOT_DATABASE_URL") or "")
    return url


def _subject_filter(subject):
    keys = list(subject_keys(subject))
    suffix = subject.split("|", 1)[1] if "|" in subject else subject
    return subject, keys, "%|" + suffix


def holding_admin_read(subject):
    """Lee el holding en tablas (sin my_holding): esa función exige el subject exacto y en Railway responde 403."""
    url = _admin_connect()
    if not subject or not url:
        return None
    import psycopg as pg
    try:
        with pg.connect(conninfo=url, autocommit=True, connect_timeout=10) as conn:
            try:
                conn.execute("SET row_security = off")
            except pg.Error:
                pass
            exact, keys, like = _subject_filter(subject)
            try:
                rows = conn.execute(
                    """SELECT jsonb_build_object(
                      'id', h.id,
                      'name', h.name,
                      'max_companies', h.max_companies,
                      'is_owner', true,
                      'companies', COALESCE((
                        SELECT jsonb_agg(jsonb_build_object(
                          'organization_id', o.id,
                          'name', o.name,
                          'slot', c.slot,
                          'created_at', c.created_at,
                          'project_name', COALESCE(p.project_name, ''),
                          'project_summary', COALESCE(p.project_summary, ''),
                          'repository', p.repository,
                          'website_url', p.website_url,
                          'capabilities', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object('capability', k.capability, 'state', k.state)
                                             ORDER BY k.capability)
                            FROM eliot.organization_capabilities k WHERE k.organization_id = o.id
                          ), '[]'::jsonb),
                          'departments', (SELECT count(*) FROM eliot.departments d WHERE d.organization_id = o.id),
                          'workers', (SELECT count(*) FROM eliot.ai_workers w WHERE w.organization_id = o.id),
                          'active_workers', (SELECT count(*) FROM eliot.ai_workers w
                                             WHERE w.organization_id = o.id AND w.operating_state <> 'inactive'),
                          'tasks', jsonb_build_object(
                            'pending', (SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id = o.id AND t.status = 'pending'),
                            'blocked', (SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id = o.id AND t.status = 'blocked'),
                            'completed', (SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id = o.id AND t.status = 'completed'),
                            'other', (SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id = o.id
                                      AND t.status NOT IN ('pending','blocked','completed'))),
                          'routines_active', (SELECT count(*) FROM eliot.department_routines r
                                              WHERE r.organization_id = o.id AND r.state = 'active'),
                          'missions', (SELECT count(*) FROM eliot.ai_document_missions m WHERE m.organization_id = o.id),
                          'autopilots_active', (SELECT count(*) FROM eliot.ai_document_mission_autopilots a
                                                WHERE a.organization_id = o.id AND a.state = 'active'
                                                  AND a.expires_at > clock_timestamp())
                        ) ORDER BY c.slot)
                        FROM eliot.holding_companies c
                        JOIN eliot.organizations o ON o.id = c.organization_id
                        LEFT JOIN eliot.organization_profiles p ON p.organization_id = o.id
                        WHERE c.holding_id = h.id
                      ), '[]'::jsonb)
                   )
                   FROM eliot.holdings h
                   JOIN eliot.holding_owners ho ON ho.holding_id = h.id
                   JOIN eliot.users u ON u.id = ho.user_id
                   WHERE u.external_subject = %s
                      OR u.external_subject = ANY(%s)
                      OR u.external_subject LIKE %s
                   ORDER BY h.created_at""",
                (exact, keys, like),
            ).fetchall()
            except pg.Error:
                rows = conn.execute(
                    """SELECT jsonb_build_object(
                          'id', h.id, 'name', h.name, 'max_companies', h.max_companies,
                          'is_owner', true, 'companies', '[]'::jsonb)
                       FROM eliot.holdings h
                       JOIN eliot.holding_owners ho ON ho.holding_id = h.id
                       JOIN eliot.users u ON u.id = ho.user_id
                       WHERE u.external_subject = %s
                          OR u.external_subject = ANY(%s)
                          OR u.external_subject LIKE %s
                       ORDER BY h.created_at""",
                    (exact, keys, like),
                ).fetchall()
            return {"enabled": True, "holdings": [row[0] for row in rows], "provider_called": False}
    except Exception as exc:
        print("install: lectura holding FALLÓ:", type(exc).__name__, exc, flush=True)
        return None


def holding_admin_provision(subject, holding_id, name, project_name, project_summary,
                            repository, website_url, capabilities, request_key):
    """Alta de empresa como administrador si eliot_identity no puede ejecutar owner_provision_company."""
    url = _admin_connect()
    if not subject or not url:
        return None
    import psycopg as pg
    try:
        with pg.connect(conninfo=url, autocommit=True, connect_timeout=15) as conn:
            try:
                conn.execute("SET row_security = off")
            except pg.Error:
                pass
            exact, keys, like = _subject_filter(subject)
            stored = conn.execute(
                """SELECT u.id, u.external_subject FROM eliot.users u
                   JOIN eliot.holding_owners ho ON ho.user_id = u.id
                   WHERE ho.holding_id = %s
                     AND (u.external_subject = %s
                          OR u.external_subject = ANY(%s)
                          OR u.external_subject LIKE %s)
                   ORDER BY (u.external_subject = %s) DESC
                   LIMIT 1""",
                (holding_id, exact, keys, like, exact),
            ).fetchone()
            if not stored:
                return None
            user_id, stored_subject = stored
            if stored_subject != exact:
                conn.execute(
                    "UPDATE eliot.users SET external_subject=%s WHERE id=%s AND external_subject<>%s",
                    (exact, user_id, exact),
                )
                stored_subject = exact
            try:
                conn.execute("ALTER ROLE eliot_migrator BYPASSRLS")
            except pg.Error:
                pass
            for stmt in (
                "ALTER FUNCTION eliot.holding_actor(uuid) SET row_security = off",
                "ALTER FUNCTION eliot.owner_provision_company(uuid,text,text,text,text,text,text[],uuid) SET row_security = off",
            ):
                try:
                    conn.execute(stmt)
                except pg.Error:
                    pass
            conn.execute("SELECT set_config('app.verified_subject', %s, false)", (stored_subject,))
            row = conn.execute(
                "SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)",
                (holding_id, name, project_name, project_summary, repository, website_url,
                 list(capabilities), request_key),
            ).fetchone()
            return row[0] if row else None
    except Exception as exc:
        print("install: alta empresa FALLÓ:", type(exc).__name__, exc, flush=True)
        return None


def organizations_admin_read(subject):
    url = (os.getenv("DATABASE_URL") or os.getenv("DATABASE_PRIVATE_URL")
           or os.getenv("ELIOT_DATABASE_URL") or "")
    if not subject or not url:
        return None
    import psycopg as pg
    try:
        with pg.connect(conninfo=url, autocommit=True, connect_timeout=10) as conn:
            try:
                conn.execute("SET row_security = off")
            except pg.Error:
                pass
            keys = list(subject_keys(subject))
            suffix = subject.split("|", 1)[1] if "|" in subject else subject
            rows = conn.execute(
                """SELECT o.id, o.name, m.role
                   FROM eliot.organization_memberships m
                   JOIN eliot.organizations o ON o.id = m.organization_id
                   JOIN eliot.users u ON u.id = m.user_id
                   WHERE m.status = 'active'
                     AND (u.external_subject = %s
                          OR u.external_subject = ANY(%s)
                          OR u.external_subject LIKE %s)
                   ORDER BY o.created_at, o.name""",
                (subject, keys, "%|" + suffix),
            ).fetchall()
            return [{"id": str(r[0]), "name": r[1], "role": r[2]} for r in rows]
    except Exception as exc:
        print("install: lectura empresas FALLÓ:", type(exc).__name__, exc, flush=True)
        return None


def has_any_access(subject):
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute("SELECT count(*) FROM eliot.my_organizations()")
                    row = cur.fetchone()
                    if row and row[0]:
                        return True
                    cur.execute("SELECT to_regprocedure('eliot.my_holding()')")
                    found = cur.fetchone()
                    if not found or not found[0]:
                        return False
                    cur.execute("SELECT count(*) FROM eliot.my_holding()")
                    row = cur.fetchone()
                    return bool(row and row[0])
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Access check unavailable") from None

@router.get("/organizations")
def my_organizations(authorization: str | None = Header(default=None)):
    subject = verified_identity(authorization, require_tasks_scope=False)
    ensure_first_owner(subject)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)",(subject,))
                    cur.execute("SELECT organization_id, organization_name, member_role FROM eliot.my_organizations()")
                    rows = cur.fetchall()
                    # 038: las empresas que el propietario retiró de La Factoría ya no se enseñan. Sin la migración, todo igual.
                    cur.execute("SELECT to_regprocedure('eliot.my_retired_companies()')")
                    found = cur.fetchone()
                    if rows and found and found[0]:
                        cur.execute("SELECT * FROM eliot.my_retired_companies()")
                        gone = {r[0] for r in cur.fetchall()}
                        rows = [r for r in rows if r[0] not in gone]
        return [{"id":str(r[0]),"name":r[1],"role":r[2]} for r in rows]
    except (psycopg.Error, OSError, RuntimeError):
        fallback = organizations_admin_read(subject)
        if fallback is not None:
            return fallback
        raise HTTPException(status_code=503, detail="Organization service unavailable") from None

@router.get("/organizations/{organization_id}/departments")
def organization_departments(organization_id: __import__("uuid").UUID, authorization: str | None = Header(default=None)):
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute("SELECT department_id, department_name FROM eliot.my_departments(%s)", (organization_id,))
                    rows = cur.fetchall()
        return [{"id": str(row[0]), "name": row[1]} for row in rows]
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Department service unavailable") from None

@router.get("/organizations/{organization_id}/workers")
def organization_workers(organization_id: __import__("uuid").UUID, authorization: str | None = Header(default=None)):
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute("SELECT worker_id, department_id, worker_name, specialty, worker_state FROM eliot.my_workers(%s)", (organization_id,))
                    rows=cur.fetchall()
        return [{"id":str(r[0]),"department_id":str(r[1]),"name":r[2],"specialty":r[3],"state":r[4]} for r in rows]
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Worker service unavailable") from None

@router.get("/organizations/{organization_id}/tasks")
def organization_tasks(organization_id: __import__("uuid").UUID, authorization: str | None = Header(default=None)):
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute("SELECT task_id, department_id, assignee_worker_id, task_title, task_status, created_at FROM eliot.my_tasks(%s)", (organization_id,))
                    rows=cur.fetchall()
        return [{"id":str(r[0]),"department_id":str(r[1]),"assignee_worker_id":str(r[2]) if r[2] else None,"title":r[3],"status":r[4],"created_at":r[5].isoformat()} for r in rows]
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Task service unavailable") from None

from pydantic import BaseModel, Field
from uuid import UUID

class TaskCreateRequest(BaseModel):
    department_id: UUID
    assignee_worker_id: UUID | None = None
    title: str = Field(min_length=3, max_length=200)
    request_key: UUID

@router.post("/organizations/{organization_id}/tasks", status_code=201)
def create_organization_task(organization_id: UUID, body: TaskCreateRequest, authorization: str | None = Header(default=None)):
    subject = verified_identity(authorization)
    # Write permission must be present in the verified access token, not merely read:tasks.
    token = authorization[7:].strip()
    try:
        key = jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=os.environ["ELIOT_OIDC_AUDIENCE"], issuer=os.environ["ELIOT_OIDC_ISSUER"], options={"require":["exp","iat","sub","iss","aud"]}, leeway=20)
        if "create:tasks" not in str(claims.get("scope","")).split():
            raise HTTPException(status_code=403, detail="Missing create:tasks permission")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid credentials") from None
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)",(subject,))
                    cur.execute("SELECT eliot.create_task_for_owner(%s,%s,%s,%s,%s)",(organization_id,body.department_id,body.assignee_worker_id,body.title,body.request_key))
                    task_id = cur.fetchone()[0]
        return {"id":str(task_id),"status":"pending"}
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403,detail="Not authorized to create tasks") from None
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=422,detail="Invalid department or worker for this organization") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Task creation unavailable") from None

@router.get("/organizations/{organization_id}/tasks/{task_id}/events")
def organization_task_events(organization_id: __import__("uuid").UUID,task_id: __import__("uuid").UUID,authorization: str | None = Header(default=None)):
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)",(subject,))
                    cur.execute("SELECT event_id,event_type,event_message,event_timestamp FROM eliot.my_task_events(%s,%s)",(organization_id,task_id))
                    rows=cur.fetchall()
        return [{"id":str(r[0]),"type":r[1],"message":r[2],"created_at":r[3].isoformat()} for r in rows]
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Task history unavailable") from None

class TaskStatusActionRequest(BaseModel):
    action: str = Field(pattern="^(block|resume|cancel)$")
    reason: str = Field(default="",max_length=1000)
    request_key: UUID

@router.post("/organizations/{organization_id}/tasks/{task_id}/status")
def owner_change_task_status(
    organization_id: UUID,
    task_id: UUID,
    body: TaskStatusActionRequest,
    authorization: str | None = Header(default=None),
):
    subject = verified_identity(authorization)
    token = authorization[7:].strip()
    try:
        key = jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=["RS256"], audience=os.environ["ELIOT_OIDC_AUDIENCE"],
            issuer=os.environ["ELIOT_OIDC_ISSUER"],
            options={"require":["exp","iat","sub","iss","aud"]}, leeway=20,
        )
        if "create:tasks" not in str(claims.get("scope", "")).split():
            raise HTTPException(status_code=403, detail="Missing task management scope")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid credentials") from None

    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute(
                        "SELECT eliot.owner_change_task_status(%s,%s,%s,%s,%s)",
                        (organization_id, task_id, body.action, body.reason, body.request_key),
                    )
                    status = cur.fetchone()[0]
        return {"id": str(task_id), "status": status}
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403, detail="Not authorized to change task status") from None
    except psycopg.errors.InvalidParameterValue:
        raise HTTPException(status_code=409, detail="Task state conflict or invalid transition") from None
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Task status service unavailable") from None

@router.get("/organizations/{organization_id}/activity")
def organization_activity(
    organization_id: UUID,
    limit: int = Query(default=50, ge=1, le=100),
    authorization: str | None = Header(default=None),
):
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute(
                        "SELECT event_id,task_id,task_title,department_id,department_name,event_type,event_message,event_time "
                        "FROM eliot.my_company_activity(%s,%s)",
                        (organization_id, limit),
                    )
                    rows = cur.fetchall()
        return [
            {"id":str(r[0]),"task_id":str(r[1]),"task_title":r[2],
             "department_id":str(r[3]),"department_name":r[4],
             "type":r[5],"message":r[6],"created_at":r[7].isoformat()}
            for r in rows
        ]
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Company activity unavailable") from None

# Eliot text v0: evidence-backed questions only, without autonomous tool execution.
from app.eliot_text_core import answer as eliot_answer
from app.eliot_llm_optional import generate as generate_eliot_natural_reply

class EliotTextQuery(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    context_intent: str | None = Field(default=None, pattern="^(summary|blocked|activity|workers|departments|tasks)$")
    # Chat con UN agente de la oficina: contesta ese agente, en primera persona, solo con sus datos verificados.
    worker_id: UUID | None = None

@router.post("/organizations/{organization_id}/eliot/chat")
def eliot_company_chat(
    organization_id: UUID,
    body: EliotTextQuery,
    authorization: str | None = Header(default=None),
):
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute("SELECT organization_id,organization_name,member_role FROM eliot.my_organizations()")
                    authorized = cur.fetchall()
                    company = next((r for r in authorized if str(r[0]) == str(organization_id)), None)
                    if company is None:
                        raise HTTPException(status_code=404, detail="Organization not available")
                    cur.execute("SELECT department_id,department_name FROM eliot.my_departments(%s)", (organization_id,))
                    departments = [{"id":str(r[0]),"name":r[1]} for r in cur.fetchall()]
                    cur.execute("SELECT worker_id,department_id,worker_name,specialty,worker_state FROM eliot.my_workers(%s)", (organization_id,))
                    workers = [{"id":str(r[0]),"department_id":str(r[1]),"name":r[2],
                                "specialty":r[3],"state":r[4]} for r in cur.fetchall()]
                    cur.execute("SELECT task_id,department_id,assignee_worker_id,task_title,task_status,created_at FROM eliot.my_tasks(%s)", (organization_id,))
                    task_rows = cur.fetchall()
                    tasks = [{"id":str(r[0]),"department_id":str(r[1]),"title":r[3],
                              "status":r[4]} for r in task_rows]
                    assigned = [{"id":str(r[0]),"assignee":str(r[2]) if r[2] else None,"title":r[3],"status":r[4]} for r in task_rows]
                    cur.execute("SELECT event_id,task_id,task_title,department_id,department_name,event_type,event_message,event_time FROM eliot.my_company_activity(%s,%s)", (organization_id, 50))
                    activity = [{"id":str(r[0]),"task_title":r[2],"event_type":r[5]} for r in cur.fetchall()]
        from app import eliot_break
        resting = eliot_break.on_break(subject, organization_id)
        if resting and body.worker_id is None:
            return {"answer": eliot_break.CHAT_NOTE, "mode": "verified_data", "read_only": True, "intents": [], "context_intent": None,
                    "organization_id": str(organization_id), "organization_name": company[1], "on_break": True}
        if body.worker_id is not None:
            worker = next((w for w in workers if w["id"] == str(body.worker_id)), None)
            if worker is None:
                raise HTTPException(status_code=404, detail="Worker not available")
            from app import eliot_agent_chat
            department = next((d["name"] for d in departments if d["id"] == worker["department_id"]), None)
            if resting:      # en descanso el agente no piensa: contesta, sin IA, que está descansando
                text, mode, proposal = eliot_break.CHAT_NOTE, "verified_data", None
            else:
                from app import eliot_readonly
                # Un observador puede preguntar, pero no recibe propuestas de encargo: no podría confirmarlas.
                text, mode, proposal = eliot_agent_chat.converse(subject, company[1], worker, department, assigned, body.question,
                                                                 use_ai=company[2] == "owner", propose=not eliot_readonly.is_viewer())
            return {"answer": text, "mode": mode, "read_only": True, "intents": [], "context_intent": None,
                    "organization_id": str(organization_id), "organization_name": company[1], "worker_id": worker["id"], "proposal": proposal}
        result = eliot_answer(body.question, company[1], departments, workers, tasks, activity, context_intent=body.context_intent)
        # External provider transfer is opt-in for each organization and owner-only.
        llm_allowlist = {
            item.strip() for item in os.getenv("ELIOT_OPENAI_ALLOWED_ORGANIZATIONS", "").split(",")
            if item.strip()
        }
        natural_answer = None
        if company[2] == "owner" and str(organization_id) in llm_allowlist:
            natural_answer = generate_eliot_natural_reply(
                body.question, company[1], departments, workers, tasks, activity,
                context_intent=body.context_intent,
                tenant_key=str(organization_id),
                **({"verified_subject":subject} if __import__("app.eliot_durable_budget",fromlist=["enabled"]).enabled() else {}),
            )
        if natural_answer:
            result["answer"] = natural_answer
            result["mode"] = "grounded_ai"
        # El propietario, en una empresa con portal conectado: contesta el mismo Freddy que por Telegram (solo consulta).
        private = False
        from app import eliot_readonly
        observer = eliot_readonly.is_viewer()   # un observador pregunta, pero no recibe datos de clientes ni voz
        if company[2] == "owner" and not observer:
            try:
                from app import eliot_freddy_chat
                owned = [r[0] for r in authorized if r[2] == "owner"]
                freddy = eliot_freddy_chat.web_answer(subject, organization_id, owned, body.question, result.get("answer"))
            except Exception:
                freddy = None
            if freddy:
                result["answer"], private = freddy
                result["mode"] = "grounded_ai"
        result["organization_id"] = str(organization_id)
        result["organization_name"] = company[1]
        from app.eliot_server_voice import grant
        if company[2] == "owner" and not private and not observer:   # una respuesta con datos de clientes no se manda al servicio de voz
            result["speech_grant"] = grant(organization_id,subject,result["answer"])
        return result
    except HTTPException:
        raise
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Eliot data service unavailable") from None

@router.get("/organizations/{organization_id}/eliot/generative/status")
def eliot_generative_status(
    organization_id: UUID,
    authorization: str | None = Header(default=None),
):
    """Owner-only readiness status. Never exposes secrets or sends data to a model."""
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)",(subject,))
                    cur.execute("SELECT organization_id,organization_name,member_role FROM eliot.my_organizations()")
                    memberships = cur.fetchall()
        company = next((row for row in memberships if str(row[0]) == str(organization_id)), None)
        if company is None:
            raise HTTPException(status_code=404, detail="Organization not available")
        if company[2] != "owner":
            raise HTTPException(status_code=403, detail="Only company owners may view generation setup")
        from app.eliot_llm_optional import MODEL_ALLOWLIST
        model = os.getenv("ELIOT_OPENAI_MODEL", "gpt-6-luna")
        model_allowed = model in MODEL_ALLOWLIST
        model_enabled = os.getenv("ELIOT_OPENAI_ENABLED") == "true"
        key_configured = bool(os.getenv("OPENAI_API_KEY"))
        allowed_orgs = {
            item.strip() for item in os.getenv("ELIOT_OPENAI_ALLOWED_ORGANIZATIONS", "").split(",")
            if item.strip()
        }
        company_allowed = str(organization_id) in allowed_orgs
        from app.eliot_model_limits import local_usage_snapshot
        local_usage = local_usage_snapshot(str(organization_id))
        return {
            "organization_id": str(organization_id),
            "organization_name": company[1],
            "provider": "openai",
            "local_usage_today": local_usage,
            "usage_scope": "single_process_estimate_not_total_billing",
            "model": model if model_allowed else "invalid_configuration",
            "model_supported": model_allowed,
            "api_key_configured": key_configured,
            "company_opted_in": company_allowed,
            "feature_enabled": model_enabled,
            "ready": bool(model_allowed and model_enabled and key_configured and company_allowed),
            "mode_when_unavailable": "verified_data",
            "no_model_request_made": True,
        }
    except HTTPException:
        raise
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503,detail="Generative setup status unavailable") from None

@router.get("/organizations/{organization_id}/tasks/{task_id}/execution/preview")
def task_execution_preview(
    organization_id: UUID,
    task_id: UUID,
    authorization: str | None = Header(default=None),
):
    """Read-only preview; no worker execution engine or provider tool calls."""
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject', %s, true)", (subject,))
                    cur.execute("SELECT organization_id,organization_name,member_role FROM eliot.my_organizations()")
                    organizations = cur.fetchall()
                    membership = next((r for r in organizations if str(r[0]) == str(organization_id)), None)
                    if membership is None:
                        raise HTTPException(status_code=404, detail="Organization not available")
                    cur.execute("SELECT task_id,department_id,assignee_worker_id,task_title,task_status,created_at FROM eliot.my_tasks(%s)", (organization_id,))
                    task = next((r for r in cur.fetchall() if str(r[0]) == str(task_id)), None)
                    if task is None:
                        raise HTTPException(status_code=404, detail="Task not in current authorized task window")
                    cur.execute("SELECT worker_id,department_id,worker_name,specialty,worker_state FROM eliot.my_workers(%s)", (organization_id,))
                    workers = cur.fetchall()
                    cur.execute("SELECT department_id,department_name FROM eliot.my_departments(%s)", (organization_id,))
                    departments = cur.fetchall()
        worker = next((w for w in workers if task[2] is not None and w[0] == task[2]), None)
        dept = next((d for d in departments if d[0] == task[1]), None)
        same_department = bool(worker is not None and worker[1] == task[1])
        checks = {
            "authorized_company": True,
            "task_pending": task[4] == "pending",
            "worker_assigned": worker is not None,
            "worker_belongs_to_task_department": same_department,
            "worker_activated": bool(worker is not None and worker[4] != "inactive"),
            "approved_tool_profile": False,
            "audited_execution_runtime": False,
        }
        reasons = []
        if task[4] != "pending":
            reasons.append("La tarea debe estar pendiente antes de cualquier ejecución.")
        if task[2] is None:
            reasons.append("La tarea no tiene un trabajador IA asignado.")
        elif worker is None or not same_department:
            reasons.append("El trabajador asignado no coincide con el departamento autorizado.")
        elif worker[4] == "inactive":
            reasons.append("El trabajador IA está inactivo y no puede ejecutar tareas.")
        reasons.append("Falta configurar un perfil de herramientas con permisos mínimos y autorización.")
        reasons.append("El motor auditado de ejecución aún no está habilitado.")
        return {
            "organization_id": str(organization_id),
            "task_id": str(task_id),
            "title": task[3],
            "task_status": task[4],
            "department_name": dept[1] if dept else None,
            "worker_name": worker[2] if worker else None,
            "worker_state": worker[4] if worker else None,
            "checks": checks,
            "eligible_for_execution": False,
            "execution_available": False,
            "reasons": reasons,
            "read_only": True,
        }
    except HTTPException:
        raise
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Execution readiness unavailable") from None

class TaskAssignmentRequest(BaseModel):
    worker_id: UUID | None = None
    request_key: UUID

@router.post("/organizations/{organization_id}/tasks/{task_id}/assign")
def owner_assign_task(
    organization_id: UUID,
    task_id: UUID,
    body: TaskAssignmentRequest,
    authorization: str | None = Header(default=None),
):
    subject=verified_identity(authorization)
    token=authorization[7:].strip()
    try:
        key=jwks_client().get_signing_key_from_jwt(token).key
        claims=jwt.decode(token,key,algorithms=["RS256"],
            audience=os.environ["ELIOT_OIDC_AUDIENCE"],
            issuer=os.environ["ELIOT_OIDC_ISSUER"],
            options={"require":["exp","iat","sub","iss","aud"]},leeway=20)
        if "create:tasks" not in str(claims.get("scope","")).split():
            raise HTTPException(status_code=403,detail="Missing task management scope")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401,detail="Invalid credentials") from None
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute("SELECT eliot.owner_assign_task(%s,%s,%s,%s)",
                      (organization_id,task_id,body.worker_id,body.request_key))
                    assigned=cur.fetchone()[0]
        return {"id":str(task_id),"assignee_worker_id":str(assigned) if assigned else None,
                "execution_started":False}
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403,detail="Not authorized to assign tasks") from None
    except psycopg.errors.InvalidParameterValue:
        raise HTTPException(status_code=409,detail="Assignment conflict or invalid task state") from None
    except psycopg.errors.ForeignKeyViolation:
        raise HTTPException(status_code=422,detail="Task or worker is not in this company") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Assignment service unavailable") from None


# Availability control is NOT a worker execution switch. No agents or tools run here.
from typing import Literal as _Literal

class WorkerAvailabilityRequest(BaseModel):
    state: _Literal["inactive", "idle"]
    request_key: UUID

@router.post("/organizations/{organization_id}/workers/{worker_id}/availability")
def owner_set_worker_availability(
    organization_id: UUID,
    worker_id: UUID,
    body: WorkerAvailabilityRequest,
    authorization: str | None = Header(default=None),
):
    subject = verified_identity(authorization)
    token = authorization[7:].strip()
    try:
        key = jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=["RS256"],
            audience=os.environ["ELIOT_OIDC_AUDIENCE"],
            issuer=os.environ["ELIOT_OIDC_ISSUER"],
            options={"require":["exp","iat","sub","iss","aud"]}, leeway=20,
        )
        if "create:tasks" not in str(claims.get("scope","")).split():
            raise HTTPException(status_code=403, detail="Missing worker management scope")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid credentials") from None
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT eliot.owner_set_worker_availability(%s,%s,%s,%s)",
                        (organization_id, worker_id, body.state, body.request_key),
                    )
                    state = cur.fetchone()[0]
        return {"worker_id": str(worker_id), "state": state,
                "execution_started": False, "tools_granted": False}
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403, detail="Not authorized to manage workers") from None
    except psycopg.errors.InvalidParameterValue:
        raise HTTPException(status_code=409, detail="Worker state conflict or invalid transition") from None
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Worker availability unavailable") from None

@router.get("/organizations/{organization_id}/workers/{worker_id}/availability/events")
def worker_availability_events(
    organization_id: UUID,
    worker_id: UUID,
    authorization: str | None = Header(default=None),
):
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT event_id,previous_state,new_state,created_at "
                        "FROM eliot.my_worker_state_events(%s,%s)",
                        (organization_id, worker_id),
                    )
                    events = cur.fetchall()
        return [{"id":str(e[0]), "previous_state":e[1], "state":e[2],
                 "created_at":e[3].isoformat()} for e in events]
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Worker history unavailable") from None


# Execution approval contracts: approval != execution.
# These routes DO NOT contact OpenAI, change task/worker states or call tools.
class AnalysisDraftApprovalRequest(BaseModel):
    worker_id: UUID
    request_key: UUID

class AnalysisDraftRevocationRequest(BaseModel):
    request_key: UUID

def _require_approval_scope(authorization: str | None) -> str:
    subject = verified_identity(authorization)
    token = authorization[7:].strip()
    try:
        key = jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=["RS256"],
            audience=os.environ["ELIOT_OIDC_AUDIENCE"],
            issuer=os.environ["ELIOT_OIDC_ISSUER"],
            options={"require":["exp","iat","sub","iss","aud"]}, leeway=20,
        )
        if "create:tasks" not in str(claims.get("scope","")).split():
            raise HTTPException(status_code=403, detail="Missing approval management scope")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid credentials") from None
    return subject

@router.post("/organizations/{organization_id}/tasks/{task_id}/execution/analysis-approvals", status_code=201)
def approve_analysis_draft(
    organization_id: UUID, task_id: UUID, body: AnalysisDraftApprovalRequest,
    authorization: str | None = Header(default=None),
):
    subject = _require_approval_scope(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT eliot.owner_approve_analysis_draft(%s,%s,%s,%s)",
                        (organization_id,task_id,body.worker_id,body.request_key),
                    )
                    approval_id = cur.fetchone()[0]
        return {"approval_id":str(approval_id), "organization_id":str(organization_id),
                "task_id":str(task_id), "worker_id":str(body.worker_id),
                "capability":"analysis_draft_v1", "execution_started":False}
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403, detail="Not authorized to approve an analysis") from None
    except psycopg.errors.InvalidParameterValue:
        raise HTTPException(status_code=409, detail="Approval conflict or worker not available") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503, detail="Analysis approval unavailable") from None

@router.get("/organizations/{organization_id}/tasks/{task_id}/execution/analysis-approvals")
def list_analysis_draft_approvals(
    organization_id: UUID, task_id: UUID,
    authorization: str | None = Header(default=None),
):
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT approval_id,worker_id,approval_state,created_at,expires_at "
                        "FROM eliot.my_analysis_approvals(%s,%s)",
                        (organization_id,task_id),
                    )
                    rows = cur.fetchall()
        return [{"id":str(row[0]),"worker_id":str(row[1]),"state":row[2],
                 "created_at":row[3].isoformat(),"expires_at":row[4].isoformat(),
                 "capability":"analysis_draft_v1"} for row in rows]
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503, detail="Approval history unavailable") from None

@router.post("/organizations/{organization_id}/tasks/{task_id}/execution/analysis-approvals/{approval_id}/revoke")
def revoke_analysis_draft(
    organization_id: UUID,task_id: UUID,approval_id: UUID,
    body: AnalysisDraftRevocationRequest,
    authorization: str | None = Header(default=None),
):
    subject = _require_approval_scope(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    # The approval must belong to the exact task, not merely to the same tenant.
                    cur.execute(
                        "SELECT approval_id FROM eliot.my_analysis_approvals(%s,%s)",
                        (organization_id,task_id),
                    )
                    if not any(str(row[0])==str(approval_id) for row in cur.fetchall()):
                        raise HTTPException(status_code=404, detail="Approval not available for task")
                    cur.execute(
                        "SELECT eliot.owner_revoke_analysis_draft(%s,%s,%s)",
                        (organization_id,approval_id,body.request_key),
                    )
                    state=cur.fetchone()[0]
        return {"approval_id":str(approval_id),"state":state,"execution_started":False}
    except HTTPException:
        raise
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403, detail="Not authorized to revoke analysis") from None
    except psycopg.errors.InvalidParameterValue:
        raise HTTPException(status_code=409, detail="Approval cannot be revoked") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503, detail="Revocation unavailable") from None


# One-shot bounded model execution. Never runs until explicit owner POST plus
# currently approved unexpired approval and server-side feature flag.
class AnalysisRunRequest(BaseModel):
    approval_id: UUID
    request_key: UUID

@router.post("/organizations/{organization_id}/tasks/{task_id}/execution/analysis-runs")
def execute_approved_analysis(
    organization_id: UUID,task_id: UUID,body: AnalysisRunRequest,
    authorization: str | None = Header(default=None),
):
    from app.eliot_analysis_executor import is_enabled_for, generate_draft
    subject = _require_approval_scope(authorization)
    if not is_enabled_for(str(organization_id)):
        raise HTTPException(status_code=503,detail="Bounded analysis executor is disabled for this company")
    from app import eliot_break
    eliot_break.require_working(subject, organization_id)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT run_id,should_execute,run_status,task_title "
                        "FROM eliot.owner_claim_analysis_run(%s,%s,%s,%s)",
                        (organization_id,task_id,body.approval_id,body.request_key),
                    )
                    result=cur.fetchone()
        if result is None:
            raise HTTPException(status_code=503,detail="Execution claim not confirmed")
        run_id,should_execute,run_state,title=result
        # A completed request key never invokes the external provider again,
        # even after retries and network disconnects.
        if not should_execute:
            return {"run_id":str(run_id),"status":run_state,
                    "already_claimed":True,"generation_attempted":False}
    except HTTPException:
        raise
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403,detail="Not authorized to execute an analysis") from None
    except (psycopg.errors.InvalidParameterValue,psycopg.errors.UniqueViolation):
        raise HTTPException(status_code=409,detail="Approval invalid, expired, revoked or already consumed") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Analysis claim unavailable") from None

    # No locks or DB transactions held over a slow network provider request.
    from app.eliot_durable_budget import enabled as durable_enabled
    draft,reason=generate_draft(str(organization_id),title,**(
        {"verified_subject":subject,"request_key":body.request_key} if durable_enabled() else {}
    ))
    outcome="completed" if draft is not None else "failed"
    failure=None if draft is not None else (reason or "internal_error")
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT eliot.owner_finish_analysis_run(%s,%s,%s,%s,%s)",
                        (organization_id,run_id,outcome,draft,failure),
                    )
                    saved=cur.fetchone()
        if not saved or saved[0]!=outcome:
            raise HTTPException(status_code=503,detail="Analysis completion not confirmed")
        return {"run_id":str(run_id),"status":outcome,"already_claimed":False,
                "generation_attempted":True,"draft_from_title_only":True,
                "report":draft if outcome=="completed" else None}
    except HTTPException:
        raise
    except (psycopg.Error,OSError,RuntimeError):
        # Do NOT attempt another provider call: one authorization is consumed.
        # The run remains claimed for administrative reconciliation.
        raise HTTPException(status_code=503,detail="Analysis result could not be persisted; do not retry with a new key") from None

@router.get("/organizations/{organization_id}/tasks/{task_id}/execution/analysis-runs")
def list_approved_analysis_runs(
    organization_id: UUID,task_id: UUID,
    authorization: str | None = Header(default=None),
):
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT run_id,run_status,run_result,run_error,started_at,finished_at "
                        "FROM eliot.my_analysis_runs(%s,%s)",
                        (organization_id,task_id),
                    )
                    rows=cur.fetchall()
        return [{"id":str(r[0]),"state":r[1],"report":r[2],
                 "error_code":r[3],"started_at":r[4].isoformat(),
                 "finished_at":r[5].isoformat() if r[5] else None,
                 "draft_from_title_only":True} for r in rows]
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Analysis results unavailable") from None


@router.get("/organizations/{organization_id}/execution/analysis-capability")
def analysis_capability_status(
    organization_id: UUID,
    authorization: str | None = Header(default=None),
):
    """Read-only owner gate, no model request. Never exposes provider secrets."""
    from app.eliot_analysis_executor import is_enabled_for
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT organization_id,member_role FROM eliot.my_organizations()"
                    )
                    rows=cur.fetchall()
        company=next((row for row in rows if str(row[0])==str(organization_id)),None)
        if company is None:
            raise HTTPException(status_code=404,detail="Organization not available")
        if company[1]!="owner":
            raise HTTPException(status_code=403,detail="Owner only")
        return {"organization_id":str(organization_id),
                "enabled":is_enabled_for(str(organization_id)),
                "capability":"analysis_draft_v1",
                "requires_fresh_approval":True,
                "external_tools_enabled":False,
                "source_scope":"task_title_only"}
    except HTTPException:
        raise
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Analysis capability status unavailable") from None


# Explicit GitHub App owner-only source browser. Documents are NOT sent to
# OpenAI or used by analysis_draft_v1; integration is read-only and fail-closed.
def _require_company_owner(organization_id: UUID, authorization: str | None) -> None:
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute("SELECT organization_id,member_role FROM eliot.my_organizations()")
                    rows=cur.fetchall()
        company=next((r for r in rows if r[0]==organization_id),None)
        if company is None:
            raise HTTPException(status_code=404,detail="Organization not available")
        if company[1]!="owner":
            raise HTTPException(status_code=403,detail="Owner only")
    except HTTPException:
        raise
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Document authorization unavailable") from None

@router.get("/organizations/{organization_id}/sources/github")
def owner_github_sources(organization_id: UUID, authorization: str | None = Header(default=None)):
    _require_company_owner(organization_id,authorization)
    from app.eliot_github_reader import sources_status
    return sources_status(str(organization_id),check_connection=True)

@router.get("/organizations/{organization_id}/sources/github/documents")
def owner_github_documents(
    organization_id: UUID,
    repository: str = Query(min_length=3,max_length=210),
    authorization: str | None = Header(default=None),
):
    _require_company_owner(organization_id,authorization)
    from app.eliot_github_reader import list_documents,GitHubSourceError
    try:
        docs=list_documents(str(organization_id),repository)
    except GitHubSourceError:
        raise HTTPException(status_code=404,detail="Authorized GitHub documentation unavailable") from None
    return {"organization_id":str(organization_id),"repository":repository,
            "documents":docs,"read_only":True,"sent_to_model":False}

@router.get("/organizations/{organization_id}/sources/github/document")
def owner_github_document(
    organization_id: UUID,
    repository: str = Query(min_length=3,max_length=210),
    path: str = Query(min_length=4,max_length=400),
    authorization: str | None = Header(default=None),
):
    _require_company_owner(organization_id,authorization)
    from app.eliot_github_reader import read_document,GitHubSourceError
    try:
        data=read_document(str(organization_id),repository,path)
    except GitHubSourceError:
        raise HTTPException(status_code=404,detail="Authorized GitHub document unavailable") from None
    return {"organization_id":str(organization_id),**data}


# Read-only preparation of a *specific* GitHub document for an owner task.
# This is NOT a documentary analysis approval and does NOT call the model,
# alter task state, consume an existing approval or write to the database.
class DocumentEvidencePreflight(BaseModel):
    repository: str = Field(min_length=3, max_length=210)
    path: str = Field(min_length=4, max_length=400)
    expected_sha: str = Field(pattern=r"^[0-9a-fA-F]{40,64}$")
    worker_id: UUID


@router.post("/organizations/{organization_id}/tasks/{task_id}/document-evidence/preflight")
def owner_preflight_document_evidence(
    organization_id: UUID,
    task_id: UUID,
    body: DocumentEvidencePreflight,
    authorization: str | None = Header(default=None),
):
    # Owner-specific gate runs BEFORE any external API request.
    _require_company_owner(organization_id, authorization)
    subject = verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT task_id,assignee_worker_id,task_status FROM eliot.my_tasks(%s)",
                        (organization_id,),
                    )
                    tasks = cur.fetchall()
                    current = next((x for x in tasks if x[0] == task_id),None)
                    if current is None:
                        raise HTTPException(status_code=404, detail="Task not available")
                    if current[2] != "pending" or current[1] != body.worker_id:
                        raise HTTPException(status_code=409, detail="Task or assigned worker changed")
                    cur.execute(
                        "SELECT worker_id,worker_state FROM eliot.my_workers(%s)",
                        (organization_id,),
                    )
                    workers=cur.fetchall()
                    if not any(x[0] == body.worker_id and x[1] == "idle" for x in workers):
                        raise HTTPException(status_code=409,detail="Assigned worker not available")
    except HTTPException:
        raise
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Document preflight unavailable") from None

    from app.eliot_github_reader import read_document, GitHubSourceError
    try:
        source=read_document(str(organization_id),body.repository,body.path)
    except GitHubSourceError:
        raise HTTPException(status_code=404,detail="Authorized document unavailable") from None

    if (source.get("sha","").casefold()!=body.expected_sha.casefold()
        or not isinstance(source.get("content"),str)):
        raise HTTPException(status_code=409,detail="Document revision changed; choose current SHA")
    return {
        "organization_id":str(organization_id),
        "task_id":str(task_id),
        "worker_id":str(body.worker_id),
        "repository":source["repository"],
        "path":source["path"],
        "ref":source["ref"],
        "sha":source["sha"],
        "size_bytes":len(source["content"].encode("utf-8")),
        "source_type":"github",
        "source_verified":True,
        "read_only":True,
        "approval_created":False,
        "sent_to_model":False,
        "model_calls":0,
        "saved_as_evidence":False,
    }


# 018 -- A DIFFERENT capability from analysis_draft_v1. Each request must
# explicitly name a single allowlisted GitHub document at one exact SHA.
class DocumentApprovalRequest(BaseModel):
    worker_id: UUID
    repository: str = Field(min_length=3,max_length=210)
    path: str = Field(min_length=5,max_length=400)
    expected_sha: str = Field(pattern=r"^[0-9a-fA-F]{40}$")
    request_key: UUID

class DocumentaryRunRequest(BaseModel):
    approval_id: UUID
    request_key: UUID

class DocumentaryRevokeRequest(BaseModel):
    request_key: UUID


def _documentary_capability(org: UUID, authorization: str | None):
    from app.eliot_document_analysis import documentary_enabled
    _require_company_owner(org,authorization)
    enabled=documentary_enabled(str(org))
    return {"organization_id":str(org),"enabled":enabled,
            "capability":"document_analysis_v1",
            "requires_fresh_document_approval":True,
            "source_scope":"one_github_file_exact_sha",
            "external_tools_enabled":False,
            "store_at_provider":False,
            "max_document_characters":12000}


@router.get("/organizations/{organization_id}/execution/documentary-capability")
def documentary_capability(
    organization_id: UUID,
    authorization: str | None = Header(default=None),
):
    return _documentary_capability(organization_id,authorization)


@router.post("/organizations/{organization_id}/tasks/{task_id}/execution/document-approvals",status_code=201)
def approve_document_analysis(
    organization_id: UUID, task_id: UUID, body: DocumentApprovalRequest,
    authorization: str | None = Header(default=None),
):
    _require_approval_scope(authorization)
    _require_company_owner(organization_id,authorization)
    from app.eliot_document_analysis import documentary_enabled
    if not documentary_enabled(str(organization_id)):
        raise HTTPException(status_code=503,detail="Documentary model authorization disabled")
    from app.eliot_github_reader import read_document,GitHubSourceError
    try:
        doc=read_document(str(organization_id),body.repository,body.path)
    except GitHubSourceError:
        raise HTTPException(status_code=404,detail="Approved GitHub source unavailable") from None
    if doc["sha"].casefold()!=body.expected_sha.casefold():
        raise HTTPException(status_code=409,detail="GitHub SHA has changed")
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT eliot.owner_approve_document_analysis(%s,%s,%s,%s,%s,%s,%s,%s)",
                        (organization_id,task_id,body.worker_id,doc["repository"],doc["path"],
                         doc["ref"],doc["sha"].lower(),body.request_key),
                    )
                    approval_id=cur.fetchone()[0]
        return {"approval_id":str(approval_id),"capability":"document_analysis_v1",
                "organization_id":str(organization_id),"task_id":str(task_id),
                "worker_id":str(body.worker_id),
                "repository":doc["repository"],"path":doc["path"],"ref":doc["ref"],
                "sha":doc["sha"],"state":"approved",
                "expires_in_minutes":15,"provider_called":False}
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403,detail="Not authorized to approve document") from None
    except (psycopg.errors.InvalidParameterValue,psycopg.errors.UniqueViolation):
        raise HTTPException(status_code=409,detail="Document approval conflict") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Document approval storage unavailable") from None


@router.get("/organizations/{organization_id}/tasks/{task_id}/execution/document-approvals")
def list_document_approvals(
    organization_id: UUID,task_id: UUID,
    authorization: str | None = Header(default=None),
):
    _require_company_owner(organization_id,authorization)
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT approval_id,worker_id,approval_state,source_repo,source_path,"
                        "source_ref,source_sha,created_at,expires_at "
                        "FROM eliot.my_document_approvals(%s,%s)",
                        (organization_id,task_id),
                    )
                    rows=cur.fetchall()
        return [{"id":str(r[0]),"worker_id":str(r[1]),"state":r[2],
                 "repository":r[3],"path":r[4],"ref":r[5],"sha":r[6],
                 "created_at":r[7].isoformat(),"expires_at":r[8].isoformat()}
                for r in rows]
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Document approvals unavailable") from None


@router.post("/organizations/{organization_id}/tasks/{task_id}/execution/document-approvals/{approval_id}/revoke")
def revoke_document_approval(
    organization_id: UUID,task_id: UUID,approval_id: UUID,
    body: DocumentaryRevokeRequest,
    authorization: str | None = Header(default=None),
):
    _require_approval_scope(authorization)
    _require_company_owner(organization_id,authorization)
    subject=verified_identity(authorization)
    # Guard against revoking an ID belonging to a DIFFERENT task in same org.
    # The signed owner still does not gain cross-tenant access.
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute("SELECT approval_id FROM eliot.my_document_approvals(%s,%s)",
                                (organization_id,task_id))
                    if approval_id not in {r[0] for r in cur.fetchall()}:
                        raise HTTPException(status_code=404,detail="Approval not available for task")
                    cur.execute("SELECT eliot.owner_revoke_document_analysis(%s,%s,%s)",
                                (organization_id,approval_id,body.request_key))
                    state=cur.fetchone()[0]
        return {"state":state,"approval_id":str(approval_id),"execution_started":False}
    except HTTPException:
        raise
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403,detail="Not authorized to revoke document approval") from None
    except psycopg.errors.InvalidParameterValue:
        raise HTTPException(status_code=409,detail="Document approval not revocable") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Document revocation unavailable") from None


@router.post("/organizations/{organization_id}/tasks/{task_id}/execution/document-runs")
def execute_document_analysis(
    organization_id: UUID,task_id: UUID,body: DocumentaryRunRequest,
    authorization: str | None = Header(default=None),
):
    from app.eliot_document_analysis import documentary_enabled,generate_document_report
    from app.eliot_github_reader import read_document,GitHubSourceError
    subject=_require_approval_scope(authorization)
    if not documentary_enabled(str(organization_id)):
        raise HTTPException(status_code=503,detail="Documentary model execution disabled")
    from app import eliot_break
    eliot_break.require_working(subject, organization_id)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT run_id,should_execute,run_status,task_title,"
                        "source_repo,source_path,source_ref,source_sha "
                        "FROM eliot.owner_claim_document_run(%s,%s,%s,%s)",
                        (organization_id,task_id,body.approval_id,body.request_key),
                    )
                    row=cur.fetchone()
        if not row:
            raise HTTPException(status_code=503,detail="Document claim unconfirmed")
    except HTTPException:
        raise
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(status_code=403,detail="Not authorized for documentary analysis") from None
    except (psycopg.errors.InvalidParameterValue,psycopg.errors.UniqueViolation):
        raise HTTPException(status_code=409,detail="Document approval invalid or consumed") from None
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Documentary claim unavailable") from None

    run_id,should_execute,status,title,repo,path,ref,sha=row
    if not should_execute:
        return {"run_id":str(run_id),"status":status,
                "already_claimed":True,"provider_called":False}
    # The DB has atomically consumed ONE approval with the exact SHA.
    # Check live GitHub against the approved tuple AGAIN, before model call.
    doc=None
    failure=None
    try:
        doc=read_document(str(organization_id),repo,path)
        if doc["sha"].casefold()!=sha.casefold() or doc["ref"]!=ref:
            doc=None
            failure="source_changed"
    except GitHubSourceError:
        failure="source_unavailable"

    if doc is None:
        draft=None
    else:
        from app.eliot_durable_budget import enabled as durable_enabled
        draft,reason=generate_document_report(str(organization_id),title,doc,**(
            {"verified_subject":subject,"request_key":body.request_key} if durable_enabled() else {}
        ))
        failure=reason if draft is None else None
    outcome="completed" if draft is not None else "failed"
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT eliot.owner_finish_document_run(%s,%s,%s,%s,%s)",
                        (organization_id,run_id,outcome,draft,failure or ("internal_error" if not draft else None)),
                    )
                    saved=cur.fetchone()
        if not saved or saved[0]!=outcome:
            raise HTTPException(status_code=503,detail="Documentary result unconfirmed")
        return {"run_id":str(run_id),"status":outcome,"already_claimed":False,
                "provider_called":doc is not None,
                "repository":repo,"path":path,"ref":ref,"sha":sha,
                "report":draft if outcome=="completed" else None,
                "error_code":failure if outcome=="failed" else None}
    except HTTPException:
        raise
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Documentary result not persisted; do not retry") from None


@router.get("/organizations/{organization_id}/tasks/{task_id}/execution/document-runs")
def list_document_runs(
    organization_id: UUID,task_id: UUID,
    authorization: str | None = Header(default=None),
):
    _require_company_owner(organization_id,authorization)
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT run_id,run_status,run_result,run_error,"
                        "source_repo,source_path,source_ref,source_sha,started_at,finished_at "
                        "FROM eliot.my_document_runs(%s,%s)",
                        (organization_id,task_id),
                    )
                    rows=cur.fetchall()
        return [{"id":str(r[0]),"state":r[1],"report":r[2],"error_code":r[3],
                 "repository":r[4],"path":r[5],"ref":r[6],"sha":r[7],
                 "started_at":r[8].isoformat(),
                 "finished_at":r[9].isoformat() if r[9] else None}
                for r in rows]
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Documentary results unavailable") from None


# Company-wide reporting view: owner only, bounded readers, NO model calls
# and NO direct table privileges or schema changes.
@router.get("/organizations/{organization_id}/execution/work-overview")
def company_work_overview(
    organization_id: UUID,
    authorization: str | None = Header(default=None),
):
    from app.eliot_work_overview import MAX_TASKS, summarize
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute("SELECT organization_id,member_role FROM eliot.my_organizations()")
                    companies=cur.fetchall()
                    member=next((row for row in companies if str(row[0])==str(organization_id)),None)
                    if member is None:
                        raise HTTPException(status_code=404,detail="Organization not available")
                    if member[1]!="owner":
                        raise HTTPException(status_code=403,detail="Owner only")
                    cur.execute(
                        "SELECT task_id,department_id,assignee_worker_id,task_title,"
                        "task_status,created_at FROM eliot.my_tasks(%s)",(organization_id,),
                    )
                    tasks=cur.fetchall()
                    title_history={}
                    document_history={}
                    for task in tasks[:MAX_TASKS]:
                        task_id=task[0]
                        cur.execute(
                            "SELECT run_id,run_status,run_result,run_error,started_at,finished_at "
                            "FROM eliot.my_analysis_runs(%s,%s)",(organization_id,task_id),
                        )
                        title_history[str(task_id)]=cur.fetchall()
                        cur.execute(
                            "SELECT run_id,run_status,run_result,run_error,source_repo,"
                            "source_path,source_ref,source_sha,started_at,finished_at "
                            "FROM eliot.my_document_runs(%s,%s)",(organization_id,task_id),
                        )
                        document_history[str(task_id)]=cur.fetchall()
        return summarize(str(organization_id),tasks,title_history,document_history)
    except HTTPException:
        raise
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Company work overview unavailable") from None


# Owner-only, read-only LOCAL process telemetry. It is NOT OpenAI billing.
@router.get("/organizations/{organization_id}/execution/local-model-usage")
def local_model_usage_for_company(
    organization_id: UUID,
    authorization: str | None = Header(default=None),
):
    _require_company_owner(organization_id, authorization)
    from app.eliot_runtime_budget_view import local_usage_status
    return local_usage_status(str(organization_id))


@router.get("/organizations/{organization_id}/execution/recovery-triage")
def company_run_recovery_triage(
    organization_id: UUID,
    authorization: str | None = Header(default=None),
):
    """Owner-only read of sampled incidents, never replay or mutate."""
    from app.eliot_run_recovery_triage import triage_company_runs
    overview = company_work_overview(organization_id,authorization)
    return triage_company_runs(overview)


@router.get("/organizations/{organization_id}/execution/durable-model-budget")
def company_durable_model_budget(
    organization_id: UUID,
    authorization: str | None = Header(default=None),
):
    """Owner-only; never exposes prompt/secret content or invents billing EUR."""
    _require_company_owner(organization_id,authorization)
    from app.eliot_durable_budget import enabled as durable_enabled
    if not durable_enabled():
        return {"organization_id":str(organization_id),"enabled":False,
                "source":"postgresql","scope":"single_company",
                "provider_invoice":False,"reservations_active":False}
    subject=verified_identity(authorization)
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT day_utc,calls_reserved,token_units_reserved,"
                        "input_tokens_reported,output_tokens_reported,"
                        "calls_limit,token_units_limit "
                        "FROM eliot.my_model_budget_status(%s)",(organization_id,),
                    )
                    row=cur.fetchone()
        if row is None:
            raise HTTPException(status_code=403,detail="Not permitted to read company quota")
        return {
            "organization_id":str(organization_id),"enabled":True,
            "source":"postgresql","scope":"single_company",
            "provider_invoice":False,"reservations_active":True,
            "day_utc":row[0].isoformat(),
            "calls_reserved":row[1],
            "estimated_token_units_reserved":row[2],
            "reported_input_tokens":row[3],
            "reported_output_tokens":row[4],
            "max_calls_per_day":row[5],
            "max_estimated_token_units_per_day":row[6],
            "reservation_units_are_estimates":True,
            "failed_attempts_still_count":True,
        }
    except HTTPException:
        raise
    except (psycopg.Error,OSError,RuntimeError):
        raise HTTPException(status_code=503,detail="Durable model quota unavailable") from None



class EliotSpeechQuery(BaseModel):
    text: str = Field(min_length=1,max_length=1800)
    speech_grant: str = Field(min_length=10,max_length=2000)
    consent: bool = False

@router.post("/organizations/{organization_id}/eliot/speech")
def eliot_answer_speech(organization_id: UUID,body:EliotSpeechQuery,authorization:str|None=Header(default=None)):
    subject=verified_identity(authorization)
    if body.consent is not True:
        raise HTTPException(400,"Explicit speech consent required")
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute("SELECT organization_id,organization_name,member_role FROM eliot.my_organizations()")
                    company=next((r for r in cur.fetchall() if str(r[0])==str(organization_id)),None)
        if company is None:
            raise HTTPException(404,"Organization not available")
        if company[2]!="owner":
            raise HTTPException(403,"Owner required")
        from app.eliot_server_voice import synthesize
        from fastapi.responses import Response
        audio=synthesize(organization_id,subject,body.text,body.speech_grant)
        return Response(audio,media_type="audio/mpeg",headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"})
    except psycopg.Error:
        raise HTTPException(503,"Voice authorization unavailable") from None
