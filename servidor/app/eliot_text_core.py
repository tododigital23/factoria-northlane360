"""Read-only, evidence-based conversational queries for one authorized organization.

This is deterministic text routing, not an LLM or autonomous director.
Always fetch and authorize the tenant before calling answer().
"""
import re
import unicodedata

MAX_ITEMS = 5
KNOWN_CONTEXTS = {"summary", "blocked", "activity", "workers", "departments", "tasks"}

def normalized(value: str) -> str:
    value = unicodedata.normalize("NFKD", value.lower())
    return "".join(ch for ch in value if not unicodedata.combining(ch))

def choose_intents(question: str, context_intent: str | None = None) -> list[str]:
    """Return all distinct read intents, with actions rejected instead of run."""
    q = normalized(question)
    if any(x in q for x in (
        "crea ", "crear ", "borra ", "elimina ", "ejecuta ", "activa ",
        "cancela ", "asigna ", "modifica ", "envia ", "cambia ",
    )):
        return ["action"]

    detected: set[str] = set()
    if any(x in q for x in ("resumen", "estado general", "como va", "situacion",
                            "mi empresa", "la empresa", "que ocurre", "como estamos")):
        detected.add("summary")
    if any(x in q for x in ("bloque", "incidenc", "problema", "alerta")):
        detected.add("blocked")
    if any(x in q for x in ("actividad", "ultimo", "ultimos", "evento", "historial", "que ha pasado")):
        detected.add("activity")
    if any(x in q for x in ("trabajador", "agente", "personal", "quien trabaja", "trabajando")):
        detected.add("workers")
    if set(re.findall("[a-z]+", q)) & {"departamento", "departamentos", "area", "areas", "equipo", "equipos"}:
        detected.add("departments")
    tasks_general = any(x in q for x in (
        "tarea", "pendiente", "trabajos asignados", "cuantos encargos",
    ))
    # "¿Qué tareas bloqueadas?" requests blocked tasks, not a redundant task summary.
    if tasks_general and ("blocked" not in detected or
                          any(x in q for x in ("pendiente", "todas las tareas", "total de tareas"))):
        detected.add("tasks")
    if detected:
        # Stable order produces coherent multi-question responses.
        return [i for i in ("summary", "departments", "workers", "tasks", "blocked", "activity")
                if i in detected]
    # Client-side context is only a topic hint. It never grants access to any tenant.
    if context_intent in KNOWN_CONTEXTS and any(
        x in q for x in ("y ", "cuant", "cuales", "dime mas", "mas detalles", "explicame", "esas", "esos")
    ):
        return [context_intent]
    return ["help"]

def choose_intent(question: str) -> str:
    """Backward-compatible single-intent helper."""
    return choose_intents(question)[0]

def answer(question: str, organization_name: str, departments: list, workers: list,
           tasks: list, activity: list, context_intent: str | None = None) -> dict:
    intents = choose_intents(question, context_intent=context_intent)
    blocked = [t for t in tasks if t["status"] == "blocked"]
    pending = [t for t in tasks if t["status"] == "pending"]
    running = [t for t in tasks if t["status"] == "running"]
    inactive = [w for w in workers if w["state"] == "inactive"]
    by_dept = {d["id"]: d["name"] for d in departments}

    replies: list[str] = []
    for intent in intents:
        if intent == "action":
            reply = ("Puedo consultar información de " + organization_name +
              ", pero este chat todavía no ejecuta órdenes. Para crear o gestionar tareas utiliza "
              "el apartado Tareas. No he modificado ningún dato.")
        elif intent == "blocked":
            if not blocked:
                reply = ("Entre las tareas consultadas de " + organization_name +
                         " no hay bloqueos registrados.")
            else:
                lines = [t["title"] + " · " + by_dept.get(t["department_id"], "Departamento sin identificar")
                         for t in blocked[:MAX_ITEMS]]
                reply = (f"Hay {len(blocked)} tarea(s) bloqueada(s) entre las consultadas en {organization_name}: "
                    + "; ".join(lines) + (". Hay más bloqueos." if len(blocked)>MAX_ITEMS else "."))
        elif intent == "departments":
            reply = (f"{organization_name} tiene {len(departments)} departamentos autorizados: " +
                     (", ".join(d["name"] for d in departments) if departments else "ninguno registrado") + ".")
        elif intent == "workers":
            reply = (f"Hay {len(workers)} trabajadores IA registrados en {organization_name}. "
                     f"{len(inactive)} están inactivos; "
                     f"{sum(w['state']=='working' for w in workers)} figuran trabajando. "
                     "Estos estados provienen de la base de datos; no he iniciado ejecuciones.")
        elif intent == "tasks":
            lines = [t["title"] + " (" + t["status"] + ")" for t in tasks[:MAX_ITEMS]]
            reply = (f"Se han consultado {len(tasks)} tareas de {organization_name}: "
                     f"{len(pending)} pendientes, {len(blocked)} bloqueadas y {len(running)} en ejecución. "
                     + ("Ejemplos: " + "; ".join(lines) + "." if lines else "No hay tareas registradas."))
        elif intent == "activity":
            lines = [ev["event_type"] + " · " + ev["task_title"] for ev in activity[:MAX_ITEMS]]
            reply = (f"Hay {len(activity)} eventos recientes consultados de {organization_name}. "
                     + ("Últimos registros: " + "; ".join(lines) + "." if lines else
                        "No existen eventos recientes en los registros consultados."))
        elif intent == "summary":
            reply = (f"Resumen verificado de {organization_name}: {len(departments)} departamentos, "
              f"{len(workers)} trabajadores IA registrados, {len(tasks)} tareas consultadas "
              f"({len(pending)} pendientes y {len(blocked)} bloqueadas) "
              f"y {len(activity)} eventos recientes. "
              f"{len(inactive)} trabajadores figuran inactivos.")
            if blocked:
                reply += " Atención: " + "; ".join(t["title"] for t in blocked[:3]) + "."
        else:
            reply = ("Puedes preguntarme por el resumen de " + organization_name +
                     ", sus departamentos, trabajadores IA, tareas pendientes, bloqueos o actividad reciente. "
                     "Esta primera versión responde con datos reales, sin IA generativa.")
        replies.append(reply)
    if intents != ["action"] and intents != ["help"]:
        replies.append("Nota: las consultas actuales están limitadas a 100 tareas y 50 eventos recientes.")
    return {
        "answer": "\n\n".join(replies),
        "intent": intents[0],
        "intents": intents,
        "context_intent": next((i for i in reversed(intents) if i in KNOWN_CONTEXTS), None),
        "mode": "verified_data",
        "read_only": True,
    }
