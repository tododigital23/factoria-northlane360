"""Almacén SQL portable (MySQL, MariaDB, SQLite, SQL Server) para La Factoría.

Reproduce las funciones que usa la oficina, el holding, la memoria, las rutinas,
los observadores y el modo descanso. El aislamiento entre empresas lo hace Python
(el sujeto verificado de cada petición), no RLS. El trabajo documental y GitHub
siguen exigiendo PostgreSQL nativo: to_regprocedure de esas firmas devuelve vacío.
"""
from __future__ import annotations

import json
import os
import re
import threading
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from uuid import UUID, uuid4

from sqlalchemy import (DateTime, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint, create_engine, func, select, and_)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, Session, sessionmaker

from app import eliot_db as db

CAPABILITIES = ("repository", "website", "seo", "marketing", "email", "orders", "monitoring", "automation")
MEMORY_KEYS = ("audience", "pricing", "value_proposition", "brand_tone", "products", "faq")
TEMPLATE = (
    (1, "Dirección IA", None, "Director de empresa IA", "Dirección, coordinación y escalado de la empresa"),
    (2, "Desarrollo", None, "Programador IA", "Repositorio, web y desarrollo de software"),
    (3, "Calidad", None, "Verificador QA", "Verificación de entregas y pruebas"),
    (4, "Operaciones", None, "Coordinador operativo IA", "Operaciones y seguimiento del proyecto"),
    (5, "Marketing", None, "Especialista de marketing IA", "Marketing digital y campañas"),
    (6, "Administración", None, "Analista administrativo IA", "Administración, costes e informes"),
    (7, "SEO y Contenidos", "seo", "Especialista SEO IA", "Posicionamiento web y contenidos"),
    (8, "Atención y Email", "email", "Gestor de email IA", "Lectura y clasificación del email de la empresa"),
    (9, "Pedidos", "orders", "Gestor de pedidos IA", "Control y seguimiento de pedidos"),
    (10, "Monitorización y Fallos", "monitoring", "Vigilante de fallos IA", "Control automático de fallos y disponibilidad"),
    (11, "Automatizaciones", "automation", "Ingeniero de automatizaciones IA", "Automatizaciones y flujos de la empresa"),
)
REPO = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
SITE = re.compile(r"^https://[A-Za-z0-9.-]{3,200}(:[0-9]{2,5})?(/\S*)?$")
SQL = re.compile(
    r"(?:SELECT\s+set_config\()|(?:SELECT\s+to_regprocedure\()|(?:SELECT\s+has_function_privilege\()"
    r"|(?:(?:FROM|SELECT)\s+eliot\.([a-z_]+)\s*\()",
    re.I,
)

IMPLEMENTED = {
    "eliot.my_organizations()", "eliot.my_departments(uuid)", "eliot.my_workers(uuid)",
    "eliot.my_tasks(uuid)", "eliot.my_task_events(uuid,uuid)", "eliot.my_company_activity(uuid,integer)",
    "eliot.create_task_for_owner(uuid,uuid,uuid,text,uuid)",
    "eliot.owner_change_task_status(uuid,uuid,text,text,uuid)",
    "eliot.owner_assign_task(uuid,uuid,uuid,uuid)",
    "eliot.owner_set_worker_availability(uuid,uuid,text,uuid)",
    "eliot.my_worker_state_events(uuid,uuid)",
    "eliot.my_holding()", "eliot.owner_provision_company(uuid,text,text,text,text,text,text[],uuid)",
    "eliot.owner_update_company_profile(uuid,text,text,text,text)",
    "eliot.owner_set_company_capability(uuid,text,text)",
    "eliot.owner_rename_company(uuid,text)",
    "eliot.owner_retire_company(uuid,text)", "eliot.my_retired_companies()",
    "eliot.my_agent_messages(uuid)",
    "eliot.my_routines(uuid)", "eliot.owner_create_routine(uuid,uuid,uuid,text,text,text,text,uuid)",
    "eliot.owner_control_routine(uuid,uuid,text)", "eliot.owner_run_due_routines(uuid)",
    "eliot.owner_request_agent_task(uuid,uuid,text,text,uuid)", "eliot.my_task_requests(uuid)",
    "eliot.my_company_memory(uuid)", "eliot.owner_set_company_memory(uuid,text,text)",
    "eliot.my_company_break(uuid)", "eliot.owner_set_company_break(uuid,boolean)",
    "eliot.company_on_break(uuid)",
    "eliot.owner_create_viewer_invite(uuid,text,text,integer)", "eliot.redeem_viewer_invite(text)",
    "eliot.owner_viewers(uuid)", "eliot.owner_revoke_viewer(uuid,uuid)",
    "eliot.my_viewer_owner_subject()", "eliot.viewer_invite_is_open(text)",
}

_engine = None
_lock = threading.Lock()


class Base(DeclarativeBase):
    pass


def _uid():
    return str(uuid4())


def _now():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "eliot_users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    external_subject: Mapped[str] = mapped_column(String(500), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Organization(Base):
    __tablename__ = "eliot_organizations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    name: Mapped[str] = mapped_column(String(180))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Membership(Base):
    __tablename__ = "eliot_memberships"
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_organizations.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Department(Base):
    __tablename__ = "eliot_departments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_organizations.id"))
    name: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    __table_args__ = (UniqueConstraint("organization_id", "name"),)


class Worker(Base):
    __tablename__ = "eliot_workers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36))
    department_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_departments.id"))
    display_name: Mapped[str] = mapped_column(String(120))
    specialty: Mapped[str] = mapped_column(String(160))
    operating_state: Mapped[str] = mapped_column(String(20), default="inactive")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    __table_args__ = (UniqueConstraint("department_id", "display_name"),)


class Task(Base):
    __tablename__ = "eliot_tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_organizations.id"))
    department_id: Mapped[str] = mapped_column(String(36))
    assignee_worker_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    request_key: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    __table_args__ = (Index("uq_task_request", "organization_id", "request_key", unique=True),)


class TaskEvent(Base):
    __tablename__ = "eliot_task_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36))
    task_id: Mapped[str] = mapped_column(String(36))
    worker_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    event_type: Mapped[str] = mapped_column(String(20))
    message: Mapped[str] = mapped_column(Text, default="")
    action_key: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class WorkerStateEvent(Base):
    __tablename__ = "eliot_worker_state_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36))
    worker_id: Mapped[str] = mapped_column(String(36))
    actor_user_id: Mapped[str] = mapped_column(String(36))
    previous_state: Mapped[str] = mapped_column(String(20))
    new_state: Mapped[str] = mapped_column(String(20))
    action_key: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    __table_args__ = (UniqueConstraint("organization_id", "worker_id", "action_key"),)


class Holding(Base):
    __tablename__ = "eliot_holdings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    name: Mapped[str] = mapped_column(String(120))
    max_companies: Mapped[int] = mapped_column(Integer, default=5)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class HoldingOwner(Base):
    __tablename__ = "eliot_holding_owners"
    holding_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_holdings.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_users.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class HoldingCompany(Base):
    __tablename__ = "eliot_holding_companies"
    holding_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_holdings.id"), primary_key=True)
    slot: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_organizations.id"), unique=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    request_key: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Profile(Base):
    __tablename__ = "eliot_org_profiles"
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("eliot_organizations.id"), primary_key=True)
    project_name: Mapped[str] = mapped_column(String(120))
    project_summary: Mapped[str] = mapped_column(String(600))
    repository: Mapped[str | None] = mapped_column(String(201), nullable=True)
    website_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Capability(Base):
    __tablename__ = "eliot_org_capabilities"
    organization_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    capability: Mapped[str] = mapped_column(String(40), primary_key=True)
    state: Mapped[str] = mapped_column(String(20), default="planned")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class HoldingAudit(Base):
    __tablename__ = "eliot_holding_audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    holding_id: Mapped[str] = mapped_column(String(36))
    organization_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor: Mapped[str] = mapped_column(String(36))
    action: Mapped[str] = mapped_column(String(40))
    detail: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class WorkerMessage(Base):
    __tablename__ = "eliot_worker_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36))
    from_worker_id: Mapped[str] = mapped_column(String(36))
    to_worker_id: Mapped[str] = mapped_column(String(36))
    task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Routine(Base):
    __tablename__ = "eliot_routines"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36))
    department_id: Mapped[str] = mapped_column(String(36))
    worker_id: Mapped[str] = mapped_column(String(36))
    title: Mapped[str] = mapped_column(String(160))
    instructions: Mapped[str] = mapped_column(Text)
    cadence: Mapped[str] = mapped_column(String(20))
    capability: Mapped[str | None] = mapped_column(String(40), nullable=True)
    state: Mapped[str] = mapped_column(String(20), default="active")
    created_by: Mapped[str] = mapped_column(String(36))
    request_key: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    __table_args__ = (UniqueConstraint("organization_id", "request_key"),)


class RoutineRun(Base):
    __tablename__ = "eliot_routine_runs"
    organization_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    routine_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    period_key: Mapped[str] = mapped_column(String(20), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class TaskRequest(Base):
    __tablename__ = "eliot_task_requests"
    organization_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    worker_id: Mapped[str] = mapped_column(String(36))
    department_id: Mapped[str] = mapped_column(String(36))
    request: Mapped[str] = mapped_column(Text)
    deliverable: Mapped[str | None] = mapped_column(String(300), nullable=True)
    requested_by: Mapped[str] = mapped_column(String(36))
    request_key: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    __table_args__ = (UniqueConstraint("organization_id", "request_key"),)


class Memory(Base):
    __tablename__ = "eliot_company_memory"
    organization_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    content: Mapped[str] = mapped_column(Text)
    updated_by: Mapped[str] = mapped_column(String(36))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Retired(Base):
    __tablename__ = "eliot_retired_companies"
    organization_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    holding_id: Mapped[str] = mapped_column(String(36))
    slot: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(180))
    retired_by: Mapped[str] = mapped_column(String(36))
    retired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Break(Base):
    __tablename__ = "eliot_company_breaks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    organization_id: Mapped[str] = mapped_column(String(36))
    started_by: Mapped[str] = mapped_column(String(36))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    ended_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Viewer(Base):
    __tablename__ = "eliot_holding_viewers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    holding_id: Mapped[str] = mapped_column(String(36))
    viewer_subject: Mapped[str] = mapped_column(String(500))
    label: Mapped[str] = mapped_column(String(80))
    invited_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Invite(Base):
    __tablename__ = "eliot_viewer_invites"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uid)
    holding_id: Mapped[str] = mapped_column(String(36))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str] = mapped_column(String(80))
    created_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    redeemed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


def sqlalchemy_url(engine_name, params):
    if engine_name == "sqlite":
        path = params.get("path") or ":memory:"
        if path == ":memory:":
            return "sqlite+pysqlite:///:memory:"
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        return "sqlite+pysqlite:///" + os.path.abspath(path).replace("\\", "/")
    if params.get("url"):
        url = params["url"]
        if engine_name == "mysql" and url.startswith("mysql://"):
            return url.replace("mysql://", "mysql+pymysql://", 1)
        if engine_name == "mariadb" and url.startswith("mariadb://"):
            return url.replace("mariadb://", "mysql+pymysql://", 1)
        if engine_name == "mssql" and not url.startswith("mssql+"):
            return url.replace("mssql://", "mssql+pyodbc://", 1).replace("sqlserver://", "mssql+pyodbc://", 1)
        return url
    user, password, host, port, name = params["user"], params["password"], params["host"], params["port"], params["dbname"]
    if engine_name in ("mysql", "mariadb"):
        return f"mysql+pymysql://{user}:{password}@{host}:{port}/{name}"
    if engine_name == "mssql":
        return f"mssql+pyodbc://{user}:{password}@{host}:{port}/{name}?driver=ODBC+Driver+18+for+SQL+Server&TrustServerCertificate=yes"
    raise RuntimeError("Unsupported portable engine")


def get_engine(engine_name=None, params=None):
    global _engine
    with _lock:
        if _engine is None:
            engine_name = engine_name or db.detect_engine()
            params = params or db.identity_params()
            url = sqlalchemy_url(engine_name, params)
            kw = {"future": True}
            if engine_name == "sqlite":
                kw["connect_args"] = {"check_same_thread": False}
            _engine = create_engine(url, **kw)
        return _engine


def reset_engine():
    global _engine
    with _lock:
        if _engine is not None:
            _engine.dispose()
        _engine = None


def migrate(engine_name=None, params=None):
    engine = get_engine(engine_name, params)
    Base.metadata.create_all(engine)
    bootstrap(engine)
    return engine


def bootstrap(engine=None):
    subject = os.getenv("ELIOT_BOOTSTRAP_SUBJECT") or ""
    if not subject.strip():
        return
    engine = engine or get_engine()
    with Session(engine) as session:
        user = session.scalar(select(User).where(User.external_subject == subject.strip()))
        if user is None:
            user = User(external_subject=subject.strip())
            session.add(user)
            session.flush()
        owner = session.scalar(select(HoldingOwner).where(HoldingOwner.user_id == user.id))
        if owner is None:
            holding = Holding(name=os.getenv("ELIOT_HOLDING_NAME", "Superempresa Freddy"))
            session.add(holding)
            session.flush()
            session.add(HoldingOwner(holding_id=holding.id, user_id=user.id))
        session.commit()


def connect(engine_name, params):
    migrate(engine_name, params)
    return PortableConnection(get_engine(engine_name, params))


def _as_uuid(value):
    return UUID(str(value)) if value is not None else None


def _json(value):
    if isinstance(value, dict):
        return {k: _json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json(v) for v in value]
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


class PortableCursor:
    def __init__(self, conn: "PortableConnection"):
        self.conn = conn
        self._rows = []
        self._i = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, args=None):
        self._rows, self._i = self.conn.dispatch(sql, args or ()), 0
        return self

    def fetchone(self):
        if self._i >= len(self._rows):
            return None
        row = self._rows[self._i]
        self._i += 1
        return row

    def fetchall(self):
        rest = self._rows[self._i:]
        self._i = len(self._rows)
        return rest


class PortableConnection:
    def __init__(self, engine):
        self.engine = engine
        self.session = Session(engine)
        self.subject = ""
        self._closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type:
            self.session.rollback()
        else:
            self.session.commit()
        self.session.close()
        self._closed = True
        return False

    @contextmanager
    def transaction(self):
        try:
            yield self
            self.session.flush()
        except Exception:
            self.session.rollback()
            raise

    def cursor(self):
        return PortableCursor(self)

    def dispatch(self, sql, args):
        text = " ".join(str(sql).split())
        args = tuple(args)
        limit = None
        if re.search(r"LIMIT\s+%s\s*$", text, re.I) or re.search(r"LIMIT\s+%s\)", text, re.I):
            limit = args[-1]
            args = args[:-1]
            text = re.sub(r"LIMIT\s+%s", "", text, flags=re.I).strip()
        if re.search(r"set_config\(\s*'app\.verified_subject'", text, re.I):
            self.subject = str(args[0]) if args else ""
            if os.getenv("ELIOT_AUTO_PROVISION_USER") == "on" and self.subject:
                self._ensure_user()
            return [(self.subject,)]
        if re.search(r"to_regprocedure\(", text, re.I):
            sig = args[0] if args else ""
            return [(sig if sig in IMPLEMENTED else None,)]
        if re.search(r"has_function_privilege\(", text, re.I):
            sig = args[0] if args else ""
            return [(bool(sig),)]
        name = None
        m = re.search(r"(?:FROM|SELECT)\s+eliot\.([a-z_]+)\s*\(", text, re.I)
        if m:
            name = m.group(1).lower()
        if not name:
            raise db.errors.UndefinedFunction("Unknown statement")
        rows = self._call(name, args)
        if re.search(r"SELECT\s+count\(\*\)", text, re.I):
            return [(len(rows),)]
        projected = self._project(text, name, rows)
        if isinstance(limit, int):
            projected = projected[:limit]
        return projected

    def _project(self, sql, name, rows):
        m = re.search(r"SELECT\s+(.+?)\s+FROM\s+eliot\.", sql, re.I)
        if not m or m.group(1).strip() == "*":
            return rows
        keys = {
            "my_organizations": ("organization_id", "organization_name", "member_role"),
            "my_departments": ("department_id", "department_name"),
            "my_workers": ("worker_id", "department_id", "worker_name", "specialty", "worker_state"),
            "my_tasks": ("task_id", "department_id", "assignee_worker_id", "task_title", "task_status", "created_at"),
            "my_task_events": ("event_id", "event_type", "event_message", "event_timestamp"),
            "my_company_activity": ("event_id", "task_id", "task_title", "department_id", "department_name",
                                    "event_type", "event_message", "event_time"),
            "my_worker_state_events": ("event_id", "previous_state", "new_state", "created_at"),
        }.get(name)
        if not keys:
            return rows
        wanted = [c.strip().split()[-1].lower() for c in m.group(1).split(",")]
        idx = [keys.index(col) for col in wanted if col in keys]
        if not idx:
            return rows
        return [tuple(row[i] for i in idx) for row in rows]

    def _ensure_user(self):
        user = self.session.scalar(select(User).where(User.external_subject == self.subject))
        if user is None:
            self.session.add(User(external_subject=self.subject))
            self.session.flush()

    def _user(self):
        if not self.subject:
            return None
        return self.session.scalar(select(User).where(User.external_subject == self.subject))

    def _member(self, org, owner=False):
        user = self._user()
        if user is None:
            raise db.errors.InsufficientPrivilege("Not authorized")
        q = select(Membership).where(Membership.organization_id == str(org),
                                     Membership.user_id == user.id, Membership.status == "active")
        if owner:
            q = q.where(Membership.role == "owner")
        row = self.session.scalar(q)
        if row is None:
            raise db.errors.InsufficientPrivilege("Not authorized")
        return user

    def _holding_actor(self, holding_id):
        user = self._user()
        if user is None:
            raise db.errors.InsufficientPrivilege("Not authorized")
        row = self.session.scalar(select(HoldingOwner).where(
            HoldingOwner.holding_id == str(holding_id), HoldingOwner.user_id == user.id))
        if row is None:
            raise db.errors.InsufficientPrivilege("Not authorized")
        return user

    def _call(self, name, args):
        fn = getattr(self, "fn_" + name, None)
        if fn is None:
            raise db.errors.UndefinedFunction(name)
        try:
            return fn(*args)
        except db.Error:
            raise
        except ValueError as exc:
            raise db.errors.InvalidParameterValue(str(exc)) from exc

    def fn_my_organizations(self):
        user = self._user()
        if user is None:
            return []
        rows = self.session.execute(
            select(Membership, Organization).join(
                Organization, Organization.id == Membership.organization_id
            ).where(Membership.user_id == user.id, Membership.status == "active")
        ).all()
        retired = {r.organization_id for r in self.session.scalars(
            select(Retired).where(Retired.retired_by == user.id)).all()}
        out = []
        for membership, org in rows:
            if org.id in retired and self.session.scalar(
                    select(HoldingCompany).where(HoldingCompany.organization_id == org.id)) is None:
                continue
            out.append((_as_uuid(org.id), org.name, membership.role))
        return out

    def fn_my_departments(self, org):
        self._member(org)
        rows = self.session.scalars(select(Department).where(Department.organization_id == str(org)).order_by(Department.name)).all()
        return [(_as_uuid(d.id), d.name) for d in rows]

    def fn_my_workers(self, org):
        self._member(org)
        rows = self.session.scalars(select(Worker).where(Worker.organization_id == str(org)).order_by(Worker.display_name)).all()
        return [(_as_uuid(w.id), _as_uuid(w.department_id), w.display_name, w.specialty, w.operating_state) for w in rows]

    def fn_my_tasks(self, org):
        self._member(org)
        rows = self.session.scalars(
            select(Task).where(Task.organization_id == str(org)).order_by(Task.created_at.desc()).limit(100)
        ).all()
        return [(_as_uuid(t.id), _as_uuid(t.department_id), _as_uuid(t.assignee_worker_id), t.title, t.status, t.created_at)
                for t in rows]

    def fn_my_task_events(self, org, task):
        self._member(org)
        rows = self.session.scalars(
            select(TaskEvent).where(TaskEvent.organization_id == str(org), TaskEvent.task_id == str(task))
            .order_by(TaskEvent.created_at.desc()).limit(100)
        ).all()
        return [(_as_uuid(e.id), e.event_type, e.message, e.created_at) for e in rows]

    def fn_my_company_activity(self, org, limit=50):
        self._member(org)
        limit = int(limit or 50)
        if not 1 <= limit <= 100:
            raise db.errors.InvalidParameterValue("Invalid limit")
        rows = self.session.execute(
            select(TaskEvent, Task, Department)
            .join(Task, and_(Task.id == TaskEvent.task_id, Task.organization_id == TaskEvent.organization_id))
            .join(Department, and_(Department.id == Task.department_id, Department.organization_id == Task.organization_id))
            .where(TaskEvent.organization_id == str(org))
            .order_by(TaskEvent.created_at.desc()).limit(limit)
        ).all()
        return [(_as_uuid(e.id), _as_uuid(t.id), t.title, _as_uuid(d.id), d.name, e.event_type, e.message, e.created_at)
                for e, t, d in rows]

    def fn_create_task_for_owner(self, org, dept, assignee, title, key):
        self._member(org, owner=True)
        title = (title or "").strip()
        if not 3 <= len(title) <= 200 or key is None:
            raise db.errors.InvalidParameterValue("Invalid title")
        prior = self.session.scalar(select(Task).where(Task.organization_id == str(org), Task.request_key == str(key)))
        if prior:
            if prior.department_id != str(dept) or prior.assignee_worker_id != (str(assignee) if assignee else None) or prior.title != title:
                raise db.errors.InvalidParameterValue("Idempotency key reused with different parameters")
            return [(_as_uuid(prior.id),)]
        task = Task(organization_id=str(org), department_id=str(dept),
                    assignee_worker_id=str(assignee) if assignee else None, title=title, request_key=str(key))
        self.session.add(task)
        self.session.flush()
        self.session.add(TaskEvent(organization_id=str(org), task_id=task.id,
                                   worker_id=str(assignee) if assignee else None,
                                   event_type="created", message="Task created by authorized owner"))
        return [(_as_uuid(task.id),)]

    def fn_owner_change_task_status(self, org, task, action, reason, key):
        self._member(org, owner=True)
        if key is None or action not in ("block", "resume", "cancel") or len(reason or "") > 1000:
            raise db.errors.InvalidParameterValue("Invalid task action")
        row = self.session.scalar(select(Task).where(Task.organization_id == str(org), Task.id == str(task)))
        if row is None:
            raise db.errors.InvalidParameterValue("Task not found")
        message = {"block": "Owner blocked task", "resume": "Owner returned task to pending",
                   "cancel": "Owner cancelled task"}[action]
        if (reason or "").strip():
            message += ": " + reason.strip()
        etype = {"block": "blocked", "resume": "reported", "cancel": "cancelled"}[action]
        saved = self.session.scalar(select(TaskEvent).where(
            TaskEvent.organization_id == str(org), TaskEvent.task_id == str(task), TaskEvent.action_key == str(key)))
        if saved:
            if saved.event_type != etype or saved.message != message:
                raise db.errors.InvalidParameterValue("Conflicting retry")
            return [(row.status,)]
        before = row.status
        if (action == "block" and before != "pending") or (action == "resume" and before != "blocked") or (
                action == "cancel" and before not in ("pending", "blocked")):
            raise db.errors.InvalidParameterValue("Invalid task transition")
        after = {"block": "blocked", "resume": "pending", "cancel": "cancelled"}[action]
        row.status, row.updated_at = after, _now()
        self.session.add(TaskEvent(organization_id=str(org), task_id=str(task), event_type=etype,
                                   message=message, action_key=str(key)))
        return [(after,)]

    def fn_owner_assign_task(self, org, task, worker, key):
        self._member(org, owner=True)
        if key is None:
            raise db.errors.InvalidParameterValue("Idempotency key required")
        row = self.session.scalar(select(Task).where(Task.organization_id == str(org), Task.id == str(task)))
        if row is None:
            raise db.errors.InvalidParameterValue("Task not found")
        saved = self.session.scalar(select(TaskEvent).where(
            TaskEvent.organization_id == str(org), TaskEvent.task_id == str(task), TaskEvent.action_key == str(key)))
        if saved:
            return [(_as_uuid(row.assignee_worker_id),)]
        wname = None
        if worker is not None:
            w = self.session.scalar(select(Worker).where(Worker.organization_id == str(org), Worker.id == str(worker)))
            if w is None or w.department_id != row.department_id:
                raise db.errors.InvalidParameterValue("Worker unavailable")
            wname = w.display_name
        row.assignee_worker_id = str(worker) if worker else None
        row.updated_at = _now()
        self.session.add(TaskEvent(organization_id=str(org), task_id=str(task),
                                   worker_id=str(worker) if worker else None,
                                   event_type="assigned",
                                   message=("Assigned to " + wname) if wname else "Unassigned",
                                   action_key=str(key)))
        return [(_as_uuid(row.assignee_worker_id),)]

    def fn_owner_set_worker_availability(self, org, worker, target, key):
        user = self._member(org, owner=True)
        if key is None or target not in ("idle", "inactive"):
            raise db.errors.InvalidParameterValue("Invalid availability request")
        w = self.session.scalar(select(Worker).where(Worker.organization_id == str(org), Worker.id == str(worker)))
        if w is None:
            raise db.errors.InvalidParameterValue("Worker unavailable")
        prior = self.session.scalar(select(WorkerStateEvent).where(
            WorkerStateEvent.organization_id == str(org), WorkerStateEvent.worker_id == str(worker),
            WorkerStateEvent.action_key == str(key)))
        if prior:
            return [(w.operating_state,)]
        if w.operating_state not in ("idle", "inactive"):
            raise db.errors.InvalidParameterValue("Worker state conflict or invalid transition")
        if w.operating_state == target:
            return [(target,)]
        before = w.operating_state
        w.operating_state = target
        self.session.add(WorkerStateEvent(organization_id=str(org), worker_id=str(worker),
                                          actor_user_id=user.id, previous_state=before, new_state=target,
                                          action_key=str(key)))
        return [(target,)]

    def fn_my_worker_state_events(self, org, worker):
        self._member(org)
        rows = self.session.scalars(select(WorkerStateEvent).where(
            WorkerStateEvent.organization_id == str(org), WorkerStateEvent.worker_id == str(worker)
        ).order_by(WorkerStateEvent.created_at.desc()).limit(50)).all()
        return [(_as_uuid(e.id), e.previous_state, e.new_state, e.created_at) for e in rows]

    def fn_my_holding(self):
        user = self._user()
        if user is None:
            raise db.errors.InsufficientPrivilege("Not authorized")
        holdings = self.session.execute(
            select(Holding).join(HoldingOwner, HoldingOwner.holding_id == Holding.id)
            .where(HoldingOwner.user_id == user.id).order_by(Holding.created_at)
        ).scalars().all()
        out = []
        for h in holdings:
            companies = []
            slots = self.session.scalars(
                select(HoldingCompany).where(HoldingCompany.holding_id == h.id).order_by(HoldingCompany.slot)
            ).all()
            for c in slots:
                org = self.session.get(Organization, c.organization_id)
                mem = self.session.scalar(select(Membership).where(
                    Membership.organization_id == c.organization_id, Membership.user_id == user.id,
                    Membership.status == "active", Membership.role == "owner"))
                if org is None or mem is None:
                    continue
                p = self.session.get(Profile, c.organization_id)
                caps = self.session.scalars(select(Capability).where(Capability.organization_id == c.organization_id)
                                            .order_by(Capability.capability)).all()
                workers = self.session.scalars(select(Worker).where(Worker.organization_id == c.organization_id)).all()
                tasks = self.session.scalars(select(Task).where(Task.organization_id == c.organization_id)).all()
                companies.append(_json({
                    "organization_id": c.organization_id, "name": org.name, "slot": c.slot,
                    "created_at": c.created_at,
                    "project_name": p.project_name if p else "", "project_summary": p.project_summary if p else "",
                    "repository": p.repository if p else None, "website_url": p.website_url if p else None,
                    "capabilities": [{"capability": k.capability, "state": k.state} for k in caps],
                    "departments": self.session.scalar(select(func.count()).select_from(Department).where(
                        Department.organization_id == c.organization_id)) or 0,
                    "workers": len(workers),
                    "active_workers": sum(1 for w in workers if w.operating_state != "inactive"),
                    "tasks": {
                        "pending": sum(1 for t in tasks if t.status == "pending"),
                        "blocked": sum(1 for t in tasks if t.status == "blocked"),
                        "completed": sum(1 for t in tasks if t.status == "completed"),
                        "other": sum(1 for t in tasks if t.status not in ("pending", "blocked", "completed")),
                    },
                    "routines_active": self.session.scalar(select(func.count()).select_from(Routine).where(
                        Routine.organization_id == c.organization_id, Routine.state == "active")) or 0,
                    "missions": 0, "autopilots_active": 0,
                }))
            out.append((_json({
                "id": h.id, "name": h.name, "max_companies": h.max_companies, "is_owner": True,
                "companies": companies,
            }),))
        return out

    def _valid_links(self, repository, website):
        r, w = (repository or "").strip() or None, (website or "").strip() or None
        if r and not REPO.fullmatch(r):
            return False
        if w and (not SITE.fullmatch(w) or len(w) > 500):
            return False
        return True

    def _ensure_capability_departments(self, org, capability):
        created = 0
        for _sort, dept, cap, worker, specialty in TEMPLATE:
            if cap != capability:
                continue
            d = self.session.scalar(select(Department).where(Department.organization_id == org, Department.name == dept))
            if d is None:
                d = Department(organization_id=org, name=dept)
                self.session.add(d)
                self.session.flush()
                created += 1
            exists = self.session.scalar(select(Worker).where(Worker.department_id == d.id, Worker.display_name == worker))
            if exists is None:
                self.session.add(Worker(organization_id=org, department_id=d.id, display_name=worker,
                                        specialty=specialty, operating_state="inactive"))
        return created

    def fn_owner_provision_company(self, holding_id, name, project_name, project_summary, repository, website, capabilities, key):
        user = self._holding_actor(holding_id)
        name, project_name, project_summary = (name or "").strip(), (project_name or "").strip(), (project_summary or "").strip()
        caps = list(capabilities or [])
        if key is None or not 2 <= len(name) <= 120 or not 2 <= len(project_name) <= 120 or not 10 <= len(project_summary) <= 600:
            raise db.errors.InvalidParameterValue("Invalid company request")
        if not self._valid_links(repository, website) or len(caps) > 8 or len(set(caps)) != len(caps):
            raise db.errors.InvalidParameterValue("Invalid company request")
        if any(c not in CAPABILITIES for c in caps):
            raise db.errors.InvalidParameterValue("Invalid company request")
        h = self.session.get(Holding, str(holding_id))
        if h is None:
            raise db.errors.InsufficientPrivilege("Not authorized")
        saved = self.session.scalar(select(HoldingCompany).where(
            HoldingCompany.holding_id == str(holding_id), HoldingCompany.request_key == str(key)))
        replayed = saved is not None
        if saved:
            org = self.session.get(Organization, saved.organization_id)
            if saved.created_by != user.id or (org and org.name != name):
                raise db.errors.InvalidParameterValue("Conflicting company retry")
            v_org, v_slot = saved.organization_id, saved.slot
        else:
            taken = self.session.execute(
                select(Organization.name).join(HoldingCompany, HoldingCompany.organization_id == Organization.id)
                .where(HoldingCompany.holding_id == str(holding_id))
            ).scalars().all()
            if any(n.lower() == name.lower() for n in taken):
                raise db.errors.ObjectNotInPrerequisiteState("Company name already used in this holding")
            used = {c.slot for c in self.session.scalars(select(HoldingCompany).where(HoldingCompany.holding_id == str(holding_id))).all()}
            v_slot = next((s for s in range(1, h.max_companies + 1) if s not in used), None)
            if v_slot is None:
                raise db.errors.ObjectNotInPrerequisiteState("Holding company limit reached")
            org = Organization(name=name)
            self.session.add(org)
            self.session.flush()
            v_org = org.id
            self.session.add(Membership(organization_id=v_org, user_id=user.id, role="owner", status="active"))
            self.session.add(HoldingCompany(holding_id=str(holding_id), slot=v_slot, organization_id=v_org,
                                            created_by=user.id, request_key=str(key)))
            self.session.add(Profile(organization_id=v_org, project_name=project_name, project_summary=project_summary,
                                     repository=(repository or "").strip() or None,
                                     website_url=(website or "").strip() or None, updated_by=user.id))
            self._ensure_capability_departments(v_org, None)
            for cap in caps:
                self.session.add(Capability(organization_id=v_org, capability=cap))
                self._ensure_capability_departments(v_org, cap)
            self.session.add(HoldingAudit(holding_id=str(holding_id), organization_id=v_org, actor=user.id,
                                          action="company_provisioned",
                                          detail=json.dumps({"slot": v_slot, "capabilities": caps, "request_key": str(key)})))
        self.session.flush()
        depts = []
        order = {row[1]: row[0] for row in TEMPLATE}
        for d in sorted(self.session.scalars(select(Department).where(Department.organization_id == v_org)).all(),
                        key=lambda x: order.get(x.name, 99)):
            depts.append({"id": d.id, "name": d.name})
        n = self.session.scalar(select(func.count()).select_from(Worker).where(Worker.organization_id == v_org)) or 0
        return [(_json({"holding_id": str(holding_id), "organization_id": v_org, "slot": v_slot, "replayed": replayed,
                        "departments": depts, "workers_created": n, "provider_called": False}),)]

    def fn_owner_update_company_profile(self, org, project_name, project_summary, repository, website):
        user = self._member(org, owner=True)
        project_name, project_summary = (project_name or "").strip(), (project_summary or "").strip()
        if not 2 <= len(project_name) <= 120 or not 10 <= len(project_summary) <= 600 or not self._valid_links(repository, website):
            raise db.errors.InvalidParameterValue("Invalid profile")
        p = self.session.get(Profile, str(org))
        if p is None:
            p = Profile(organization_id=str(org), project_name=project_name, project_summary=project_summary)
            self.session.add(p)
        p.project_name, p.project_summary = project_name, project_summary
        p.repository = (repository or "").strip() or None
        p.website_url = (website or "").strip() or None
        p.updated_by, p.updated_at = user.id, _now()
        return [(_json({"organization_id": str(org), "updated": True}),)]

    def fn_owner_set_company_capability(self, org, capability, state):
        user = self._member(org, owner=True)
        if capability not in CAPABILITIES or state not in ("planned", "disabled"):
            raise db.errors.InvalidParameterValue("Invalid capability change")
        row = self.session.get(Capability, (str(org), capability))
        if row is None:
            row = Capability(organization_id=str(org), capability=capability, state=state)
            self.session.add(row)
        else:
            row.state, row.updated_at = state, _now()
        created = self._ensure_capability_departments(str(org), capability) if state == "planned" else 0
        hc = self.session.scalar(select(HoldingCompany).where(HoldingCompany.organization_id == str(org)))
        if hc:
            self.session.add(HoldingAudit(holding_id=hc.holding_id, organization_id=str(org), actor=user.id,
                                          action="capability_changed",
                                          detail=json.dumps({"capability": capability, "state": state})))
        return [(_json({"organization_id": str(org), "capability": capability, "state": state,
                        "departments_created": created}),)]

    def fn_owner_rename_company(self, org, name):
        user = self._member(org, owner=True)
        new = (name or "").strip()
        if not 2 <= len(new) <= 120 or re.search(r"[\x00-\x1f\x7f]", new):
            raise db.errors.InvalidParameterValue("Invalid company name")
        hc = self.session.scalar(select(HoldingCompany).where(HoldingCompany.organization_id == str(org)))
        if hc is None:
            raise db.errors.ObjectNotInPrerequisiteState("Company is not part of a holding")
        org_row = self.session.get(Organization, str(org))
        if org_row.name == new:
            return [(_json({"organization_id": str(org), "name": new, "renamed": False}),)]
        others = self.session.execute(
            select(Organization).join(HoldingCompany, HoldingCompany.organization_id == Organization.id)
            .where(HoldingCompany.holding_id == hc.holding_id, Organization.id != str(org))
        ).scalars().all()
        if any(o.name.lower() == new.lower() for o in others):
            raise db.errors.ObjectNotInPrerequisiteState("Company name already used in this holding")
        old = org_row.name
        org_row.name = new
        self.session.add(HoldingAudit(holding_id=hc.holding_id, organization_id=str(org), actor=user.id,
                                      action="company_renamed", detail=json.dumps({"from": old, "to": new})))
        return [(_json({"organization_id": str(org), "name": new, "renamed": True}),)]

    def fn_owner_retire_company(self, org, confirm_name):
        user = self._member(org, owner=True)
        hc = self.session.scalar(select(HoldingCompany).where(HoldingCompany.organization_id == str(org)))
        if hc is None:
            raise db.errors.ObjectNotInPrerequisiteState("Company is not part of a holding")
        self._holding_actor(hc.holding_id)
        org_row = self.session.get(Organization, str(org))
        if (confirm_name or "").strip() != org_row.name:
            raise db.errors.InvalidParameterValue("Company name does not match")
        holding_id, slot, name = hc.holding_id, hc.slot, org_row.name
        paused = 0
        for r in self.session.scalars(select(Routine).where(Routine.organization_id == str(org), Routine.state == "active")).all():
            r.state = "paused"
            paused += 1
        self.session.delete(hc)
        existing = self.session.get(Retired, str(org))
        if existing:
            existing.holding_id, existing.slot, existing.name, existing.retired_by, existing.retired_at = (
                holding_id, slot, name, user.id, _now())
        else:
            self.session.add(Retired(organization_id=str(org), holding_id=holding_id, slot=slot,
                                     name=name, retired_by=user.id))
        self.session.add(HoldingAudit(holding_id=holding_id, organization_id=str(org), actor=user.id,
                                      action="company_retired",
                                      detail=json.dumps({"name": name, "slot": slot, "routines_paused": paused})))
        return [(_json({"organization_id": str(org), "name": name, "slot": slot, "retired": True,
                        "routines_paused": paused}),)]

    def fn_my_retired_companies(self):
        user = self._user()
        if user is None:
            return []
        rows = self.session.scalars(select(Retired)).all()
        out = []
        for r in rows:
            mem = self.session.scalar(select(Membership).where(
                Membership.organization_id == r.organization_id, Membership.user_id == user.id, Membership.status == "active"))
            still = self.session.scalar(select(HoldingCompany).where(HoldingCompany.organization_id == r.organization_id))
            if mem and still is None:
                out.append((_as_uuid(r.organization_id),))
        return out

    def fn_my_agent_messages(self, org):
        self._member(org, owner=True)
        rows = self.session.scalars(select(WorkerMessage).where(WorkerMessage.organization_id == str(org))
                                    .order_by(WorkerMessage.created_at.desc()).limit(50)).all()
        out = []
        for m in rows:
            fw = self.session.get(Worker, m.from_worker_id)
            tw = self.session.get(Worker, m.to_worker_id)
            out.append((_json({"id": m.id, "from_worker_id": m.from_worker_id, "from_worker": fw.display_name if fw else "",
                               "to_worker_id": m.to_worker_id, "to_worker": tw.display_name if tw else "",
                               "task_id": m.task_id, "body": m.body, "created_at": m.created_at}),))
        return out

    def fn_my_routines(self, org):
        self._member(org, owner=True)
        rows = self.session.scalars(select(Routine).where(Routine.organization_id == str(org))
                                    .order_by(Routine.created_at.desc()).limit(100)).all()
        out = []
        for r in rows:
            d = self.session.get(Department, r.department_id)
            w = self.session.get(Worker, r.worker_id)
            runs = self.session.scalars(select(RoutineRun).where(
                RoutineRun.organization_id == str(org), RoutineRun.routine_id == r.id)).all()
            last = max((x.period_key for x in runs), default=None)
            out.append((_json({"id": r.id, "department_id": r.department_id, "department": d.name if d else "",
                               "worker_id": r.worker_id, "worker": w.display_name if w else "",
                               "title": r.title, "instructions": r.instructions, "cadence": r.cadence,
                               "capability": r.capability, "state": r.state, "created_at": r.created_at,
                               "last_period": last, "runs": len(runs)}),))
        return out

    def fn_owner_create_routine(self, org, department, worker, title, instructions, cadence, capability, key):
        user = self._member(org, owner=True)
        title, instructions = (title or "").strip(), (instructions or "").strip()
        if key is None or not 3 <= len(title) <= 160 or not 10 <= len(instructions) <= 2000 or cadence not in ("daily", "weekly", "monthly"):
            raise db.errors.InvalidParameterValue("Invalid routine")
        if capability is not None and capability not in CAPABILITIES:
            raise db.errors.InvalidParameterValue("Invalid routine capability")
        saved = self.session.scalar(select(Routine).where(Routine.organization_id == str(org), Routine.request_key == str(key)))
        if saved:
            if saved.department_id != str(department) or saved.worker_id != str(worker) or saved.title != title or saved.cadence != cadence:
                raise db.errors.InvalidParameterValue("Conflicting routine retry")
            return [(_as_uuid(saved.id),)]
        w = self.session.scalar(select(Worker).where(
            Worker.organization_id == str(org), Worker.id == str(worker), Worker.department_id == str(department)))
        if w is None:
            raise db.errors.InvalidParameterValue("Worker must belong to the department of this company")
        r = Routine(organization_id=str(org), department_id=str(department), worker_id=str(worker),
                    title=title, instructions=instructions, cadence=cadence, capability=capability,
                    created_by=user.id, request_key=str(key))
        self.session.add(r)
        self.session.flush()
        return [(_as_uuid(r.id),)]

    def fn_owner_control_routine(self, org, routine, state):
        self._member(org, owner=True)
        if state not in ("active", "paused"):
            raise db.errors.InvalidParameterValue("Invalid routine state")
        r = self.session.scalar(select(Routine).where(Routine.organization_id == str(org), Routine.id == str(routine)))
        if r is None:
            raise db.errors.InvalidParameterValue("Routine unavailable")
        r.state = state
        return [(_json({"routine_id": str(routine), "state": state}),)]

    def fn_owner_run_due_routines(self, org):
        self._member(org, owner=True)
        created = 0
        now = _now()
        iso = now.isocalendar()
        for r in self.session.scalars(select(Routine).where(Routine.organization_id == str(org), Routine.state == "active")).all():
            period = {"daily": now.strftime("%Y-%m-%d"), "weekly": f"{iso.year}-W{iso.week:02d}",
                      "monthly": now.strftime("%Y-%m")}[r.cadence]
            exists = self.session.get(RoutineRun, (str(org), r.id, period))
            if exists:
                continue
            task = Task(organization_id=str(org), department_id=r.department_id, assignee_worker_id=r.worker_id,
                        title=(r.title[:180] + " · " + period)[:200])
            self.session.add(task)
            self.session.flush()
            self.session.add(RoutineRun(organization_id=str(org), routine_id=r.id, period_key=period, task_id=task.id))
            self.session.add(TaskEvent(organization_id=str(org), task_id=task.id, worker_id=r.worker_id,
                                       event_type="reported",
                                       message=f"Recurring routine {r.id} created this pending task for period {period}; no execution"))
            created += 1
        return [(created,)]

    def fn_owner_request_agent_task(self, org, worker, request, deliverable, key):
        user = self._member(org, owner=True)
        request = (request or "").strip()
        deliverable = (deliverable or "").strip() or None
        if key is None or worker is None or not 10 <= len(request) <= 2000:
            raise db.errors.InvalidParameterValue("Invalid request")
        if deliverable is not None and not 1 <= len(deliverable) <= 300:
            raise db.errors.InvalidParameterValue("Invalid request")
        saved = self.session.scalar(select(TaskRequest).where(
            TaskRequest.organization_id == str(org), TaskRequest.request_key == str(key)))
        if saved:
            if saved.worker_id != str(worker) or saved.request != request or saved.deliverable != deliverable or saved.requested_by != user.id:
                raise db.errors.InvalidParameterValue("Conflicting request retry")
            t = self.session.get(Task, saved.task_id)
            return [(_json({"organization_id": str(org), "worker_id": saved.worker_id, "task_id": saved.task_id,
                            "department_id": saved.department_id, "title": t.title if t else "", "status": "pending",
                            "replayed": True, "execution_started": False}),)]
        w = self.session.scalar(select(Worker).where(Worker.organization_id == str(org), Worker.id == str(worker)))
        if w is None:
            raise db.errors.InvalidParameterValue("Worker unavailable")
        first = re.sub(r"\s+", " ", request.split("\n", 1)[0]).strip()
        title = first if len(first) <= 150 else re.sub(r"\s+\S*$", "", first[:150]) + "…"
        if len(title) < 3:
            title = "Encargo para " + w.display_name
        task_id = self.fn_create_task_for_owner(org, w.department_id, worker, title, key)[0][0]
        self.session.add(TaskRequest(organization_id=str(org), task_id=str(task_id), worker_id=str(worker),
                                     department_id=w.department_id, request=request, deliverable=deliverable,
                                     requested_by=user.id, request_key=str(key)))
        self.session.add(TaskEvent(organization_id=str(org), task_id=str(task_id), worker_id=str(worker),
                                   event_type="reported",
                                   message=f"Owner request recorded for {w.display_name}; pending, no execution or provider call"))
        return [(_json({"organization_id": str(org), "worker_id": str(worker), "task_id": str(task_id),
                        "department_id": w.department_id, "title": title, "status": "pending",
                        "replayed": False, "execution_started": False}),)]

    def fn_my_task_requests(self, org):
        self._member(org, owner=True)
        rows = self.session.scalars(select(TaskRequest).where(TaskRequest.organization_id == str(org))
                                    .order_by(TaskRequest.created_at.desc()).limit(50)).all()
        out = []
        for r in rows:
            t = self.session.get(Task, r.task_id)
            out.append((_json({"task_id": r.task_id, "worker_id": r.worker_id, "department_id": r.department_id,
                               "title": t.title if t else "", "request": r.request, "deliverable": r.deliverable,
                               "task_status": t.status if t else "pending", "created_at": r.created_at}),))
        return out

    def fn_my_company_memory(self, org):
        self._member(org, owner=True)
        rows = self.session.scalars(select(Memory).where(Memory.organization_id == str(org))).all()
        order = {k: i for i, k in enumerate(MEMORY_KEYS)}
        rows = sorted(rows, key=lambda m: order.get(m.key, 99))
        return [(_json({"key": m.key, "content": m.content, "updated_at": m.updated_at}),) for m in rows]

    def fn_owner_set_company_memory(self, org, key, content):
        user = self._member(org, owner=True)
        if key not in MEMORY_KEYS or content is None or len(content) > 2000:
            raise db.errors.InvalidParameterValue("Invalid memory item")
        row = self.session.get(Memory, (str(org), key))
        if row is None:
            self.session.add(Memory(organization_id=str(org), key=key, content=content.strip(), updated_by=user.id))
        else:
            row.content, row.updated_by, row.updated_at = content.strip(), user.id, _now()
        return [(_json({"organization_id": str(org), "key": key, "updated": True}),)]

    def fn_my_company_break(self, org):
        self._member(org)
        row = self.session.scalar(select(Break).where(Break.organization_id == str(org), Break.ended_at.is_(None)))
        return [(_json({"organization_id": str(org), "on_break": row is not None,
                        "since": row.started_at if row else None}),)]

    def fn_owner_set_company_break(self, org, on):
        user = self._member(org, owner=True)
        if on is None:
            raise db.errors.InvalidParameterValue("Missing value")
        row = self.session.scalar(select(Break).where(Break.organization_id == str(org), Break.ended_at.is_(None)))
        changed = False
        since = row.started_at if row else None
        if on and row is None:
            row = Break(organization_id=str(org), started_by=user.id)
            self.session.add(row)
            self.session.flush()
            since, changed = row.started_at, True
        elif (not on) and row is not None:
            row.ended_at, row.ended_by = _now(), user.id
            since, changed = None, True
        return [(_json({"organization_id": str(org), "on_break": since is not None, "since": since, "changed": changed}),)]

    def fn_company_on_break(self, org):
        row = self.session.scalar(select(Break).where(Break.organization_id == str(org), Break.ended_at.is_(None)))
        return [(row is not None,)]

    def fn_owner_create_viewer_invite(self, holding_id, label, token_hash, hours):
        user = self._holding_actor(holding_id)
        label = (label or "").strip()
        if not 1 <= len(label) <= 80 or not token_hash or not re.fullmatch(r"[0-9a-f]{64}", token_hash) or hours is None or not 1 <= int(hours) <= 168:
            raise db.errors.InvalidParameterValue("Invalid invite")
        active = self.session.scalar(select(func.count()).select_from(Viewer).where(
            Viewer.holding_id == str(holding_id), Viewer.revoked_at.is_(None))) or 0
        pending = self.session.scalar(select(func.count()).select_from(Invite).where(
            Invite.holding_id == str(holding_id), Invite.redeemed_at.is_(None), Invite.cancelled_at.is_(None),
            Invite.expires_at > _now())) or 0
        if active + pending >= 10:
            raise db.errors.ObjectNotInPrerequisiteState("Viewer limit reached")
        exp = _now() + timedelta(hours=int(hours))
        inv = Invite(holding_id=str(holding_id), token_hash=token_hash, label=label, created_by=user.id, expires_at=exp)
        self.session.add(inv)
        self.session.flush()
        self.session.add(HoldingAudit(holding_id=str(holding_id), actor=user.id, action="viewer_invited",
                                      detail=json.dumps({"invite_id": inv.id, "label": label})))
        return [(_json({"invite_id": inv.id, "holding_id": str(holding_id), "label": label,
                        "expires_at": exp, "created": True}),)]

    def fn_redeem_viewer_invite(self, token_hash):
        if not self.subject or not 3 <= len(self.subject) <= 500:
            raise db.errors.InsufficientPrivilege("Not authorized")
        inv = self.session.scalar(select(Invite).where(Invite.token_hash == token_hash))
        if inv is None or inv.redeemed_at or inv.cancelled_at or inv.expires_at <= _now():
            raise db.errors.InvalidParameterValue("Invite not valid")
        if self.session.scalar(select(HoldingOwner).join(User, User.id == HoldingOwner.user_id)
                               .where(User.external_subject == self.subject)):
            raise db.errors.ObjectNotInPrerequisiteState("Owners cannot be viewers")
        if self.session.scalar(select(Viewer).where(Viewer.viewer_subject == self.subject, Viewer.revoked_at.is_(None))):
            raise db.errors.ObjectNotInPrerequisiteState("Already a viewer")
        self.session.add(Viewer(holding_id=inv.holding_id, viewer_subject=self.subject, label=inv.label, invited_by=inv.created_by))
        inv.redeemed_at = _now()
        h = self.session.get(Holding, inv.holding_id)
        return [(_json({"holding_id": inv.holding_id, "holding": h.name if h else "", "joined": True}),)]

    def fn_owner_viewers(self, holding_id):
        self._holding_actor(holding_id)
        viewers = self.session.scalars(select(Viewer).where(
            Viewer.holding_id == str(holding_id), Viewer.revoked_at.is_(None)).order_by(Viewer.created_at)).all()
        invites = self.session.scalars(select(Invite).where(
            Invite.holding_id == str(holding_id), Invite.redeemed_at.is_(None), Invite.cancelled_at.is_(None),
            Invite.expires_at > _now()).order_by(Invite.created_at)).all()
        return [(_json({"holding_id": str(holding_id),
                        "viewers": [{"id": v.id, "label": v.label, "since": v.created_at} for v in viewers],
                        "invites": [{"id": i.id, "label": i.label, "expires_at": i.expires_at} for i in invites]}),)]

    def fn_owner_revoke_viewer(self, holding_id, item_id):
        user = self._holding_actor(holding_id)
        v = self.session.scalar(select(Viewer).where(
            Viewer.id == str(item_id), Viewer.holding_id == str(holding_id), Viewer.revoked_at.is_(None)))
        kind, label = None, None
        if v:
            v.revoked_at, kind, label = _now(), "viewer", v.label
        else:
            inv = self.session.scalar(select(Invite).where(
                Invite.id == str(item_id), Invite.holding_id == str(holding_id),
                Invite.redeemed_at.is_(None), Invite.cancelled_at.is_(None)))
            if inv is None:
                raise db.errors.InvalidParameterValue("Nothing to revoke")
            inv.cancelled_at, kind, label = _now(), "invite", inv.label
        self.session.add(HoldingAudit(holding_id=str(holding_id), actor=user.id, action="viewer_revoked",
                                      detail=json.dumps({"id": str(item_id), "label": label, "kind": kind})))
        return [(_json({"holding_id": str(holding_id), "id": str(item_id), "kind": kind, "revoked": True}),)]

    def fn_my_viewer_owner_subject(self):
        v = self.session.scalar(select(Viewer).where(Viewer.viewer_subject == self.subject, Viewer.revoked_at.is_(None)))
        if v is None:
            return [(None,)]
        owner = self.session.execute(
            select(User).join(HoldingOwner, HoldingOwner.user_id == User.id)
            .where(HoldingOwner.holding_id == v.holding_id).order_by(User.created_at)
        ).scalars().first()
        return [(owner.external_subject if owner else None,)]

    def fn_viewer_invite_is_open(self, token_hash):
        ok = bool(token_hash and re.fullmatch(r"[0-9a-f]{64}", token_hash) and self.session.scalar(
            select(Invite).where(Invite.token_hash == token_hash, Invite.redeemed_at.is_(None),
                                 Invite.cancelled_at.is_(None), Invite.expires_at > _now())))
        return [(ok,)]


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Esquema portable de La Factoría")
    parser.add_argument("command", choices=("migrate", "bootstrap"))
    args = parser.parse_args()
    migrate()
    if args.command == "bootstrap":
        bootstrap()
    print("ok", db.detect_engine())


if __name__ == "__main__":
    main()
