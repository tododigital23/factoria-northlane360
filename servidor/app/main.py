"""ELIOT API starter. In-memory demo only: no production user data."""
from datetime import datetime, timezone
from enum import Enum
from uuid import UUID, uuid4
import hmac
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="ELIOT Centro de Mando IA", version="0.2.0")
_tasks: dict[UUID, dict] = {}

class Status(str, Enum):
    pending = "pending"
    approved = "approved"
    running = "running"
    completed = "completed"
    failed = "failed"

class NewTask(BaseModel):
    organization_id: UUID
    title: str = Field(min_length=3, max_length=180)
    description: str = Field(default="", max_length=4000)
    agent_role: str = Field(default="analyst", max_length=60)

class Task(BaseModel):
    id: UUID
    organization_id: UUID
    title: str
    description: str
    agent_role: str
    status: Status
    created_at: datetime

def require_demo_access(key: str | None):
    expected = os.environ.get("ELIOT_DEMO_KEY")
    if not expected or not key or not hmac.compare_digest(key, expected):
        raise HTTPException(status_code=403, detail="Demo disabled or unauthorized")

@app.get("/health")
def health():
    return {"status": "ok", "service": "eliot-api", "version": "0.2.1"}

@app.post("/demo/tasks", response_model=Task, status_code=201)
def create_demo_task(body: NewTask, x_demo_key: str | None = Header(default=None)):
    require_demo_access(x_demo_key)
    task = Task(id=uuid4(), status=Status.pending,
                created_at=datetime.now(timezone.utc), **body.model_dump())
    _tasks[task.id] = task.model_dump()
    return task

@app.get("/demo/tasks", response_model=list[Task])
def list_demo_tasks(organization_id: UUID, x_demo_key: str | None = Header(default=None)):
    require_demo_access(x_demo_key)
    return [Task(**v) for v in _tasks.values() if v["organization_id"] == organization_id]


# Organizations API is opt-in and remains disabled unless explicitly enabled.
# The feature flag must only be set after authenticated E2E checks and review.
if os.environ.get("ELIOT_ENABLE_ORGANIZATIONS_API") == "true":
    from fastapi.middleware.cors import CORSMiddleware
    from app.organizations_api import router as organizations_router

    from app.eliot_db import frontend_origins
    APPROVED_FRONTEND_ORIGINS = frontend_origins()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(APPROVED_FRONTEND_ORIGINS),
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,
    )
    # Acceso de solo consulta: se anota el método y la ruta de cada petición para poder frenar a un observador en un único punto.
    from app import eliot_readonly

    class _RememberRequest:
        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope.get("type") == "http":
                eliot_readonly.remember(scope.get("method"), scope.get("path"))
            await self.inner(scope, receive, send)
    app.add_middleware(_RememberRequest)
    app.include_router(organizations_router)
    from app import eliot_notifier
    eliot_notifier.start()  # avisos al propietario por Telegram; no hace nada si no está configurado
    from app.eliot_tool_control_api import router as tool_control_router
    app.include_router(tool_control_router)
    from app.eliot_document_jobs_api import router as document_jobs_router
    app.include_router(document_jobs_router)
    from app.eliot_document_reviews_api import router as document_reviews_router
    app.include_router(document_reviews_router)
    from app.eliot_document_quality_api import router as document_quality_router
    app.include_router(document_quality_router)
    from app.eliot_document_plans_api import router as document_plans_router
    app.include_router(document_plans_router)
    from app.eliot_plan_tracking_api import router as plan_tracking_router
    app.include_router(plan_tracking_router)
    from app.eliot_document_missions_api import router as document_missions_router
    app.include_router(document_missions_router)
    from app.eliot_office_api import router as office_router
    app.include_router(office_router)
    from app.eliot_objective_planning_api import router as objective_planning_router
    app.include_router(objective_planning_router)
    from app.eliot_mission_autopilot_api import router as mission_autopilot_router
    app.include_router(mission_autopilot_router)
    from app.eliot_holding_api import router as holding_router
    app.include_router(holding_router)
    from app.eliot_portal_agents_api import router as portal_agents_router, push_router as portal_push_router
    app.include_router(portal_agents_router)
    app.include_router(portal_push_router)
    from app.eliot_integration_assistant import router as integration_router
    app.include_router(integration_router)
    from app.eliot_auth_api import router as auth_router
    app.include_router(auth_router)
    from app.eliot_break import router as break_router
    app.include_router(break_router)
    from app.eliot_viewers_api import router as viewers_router
    app.include_router(viewers_router)
    from app.eliot_storage_api import router as storage_router
    app.include_router(storage_router)


    # Temporary, opt-in startup diagnostic for a single explicitly configured
    # organization. Outputs only fixed status codes; never PEMs, JWTs or tokens.
    # Must be disabled after troubleshooting to avoid routine startup API calls.
    diagnostic_org = os.environ.get("ELIOT_GITHUB_DIAGNOSE_ORGANIZATION_ID", "")
    if diagnostic_org:
        import logging
        diagnostic_logger = logging.getLogger("eliot.github_readonly")
        def _github_startup_diagnostic():
            try:
                organization_id = str(UUID(diagnostic_org))
                from app.eliot_github_reader import sources_status
                result = sources_status(organization_id, check_connection=True)
                diagnostic_logger.warning(
                    "GitHub read-only diagnostic connected=%s stage=%s",
                    bool(result["connected"]), result["connection_issue"]
                )
            except Exception:
                diagnostic_logger.warning(
                    "GitHub read-only diagnostic connected=False stage=unexpected_internal_error"
                )
        app.router.on_startup.append(_github_startup_diagnostic)
