"""Per-process experimental guardrail for external Eliot model requests.

These limits reduce accidental bursts but do NOT replace provider billing limits
or an organization-wide durable quota. Each API process maintains independent
state and resets on restart. Never stores request content or credentials.
"""
from collections import defaultdict, deque
from datetime import datetime, timezone
from threading import Lock
import os
import time

_guard = Lock()
_recent_calls: dict[str, deque[float]] = defaultdict(deque)
_daily_calls: dict[tuple[str, str], int] = defaultdict(int)
_usage: dict[tuple[str, str], dict[str, int]] = defaultdict(
    lambda: {"requests": 0, "input_tokens": 0, "output_tokens": 0}
)

def _limit(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return min(max(value, low), high)

def reserve_model_request(tenant_id: str, *, now: float | None = None) -> bool:
    """One reservation before provider call; failures still count toward cap."""
    if not tenant_id:
        return False
    instant = time.time() if now is None else now
    day = datetime.fromtimestamp(instant, tz=timezone.utc).strftime("%Y-%m-%d")
    rpm = _limit("ELIOT_OPENAI_MAX_CALLS_PER_MINUTE", 15, 1, 30)
    daily = _limit("ELIOT_OPENAI_MAX_CALLS_PER_DAY", 100, 1, 500)
    with _guard:
        history = _recent_calls[tenant_id]
        while history and history[0] <= instant - 60:
            history.popleft()
        if len(history) >= rpm or _daily_calls[(tenant_id, day)] >= daily:
            return False
        history.append(instant)
        _daily_calls[(tenant_id, day)] += 1
        _usage[(tenant_id, day)]["requests"] += 1
        # Prune old daily in-memory records, never keep indefinite history.
        if len(_daily_calls) > 10000:
            for key in tuple(_daily_calls):
                if key[1] != day:
                    _daily_calls.pop(key, None)
                    _usage.pop(key, None)
        return True

def record_token_usage(tenant_id: str, response: dict, *, now: float | None = None) -> None:
    """Only aggregate numbers reported by the Responses API, never content."""
    if not tenant_id:
        return
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return
    instant = time.time() if now is None else now
    day = datetime.fromtimestamp(instant, tz=timezone.utc).strftime("%Y-%m-%d")
    with _guard:
        totals = _usage[(tenant_id, day)]
        for source, target in (("input_tokens", "input_tokens"), ("output_tokens", "output_tokens")):
            value = usage.get(source)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                totals[target] += value

def local_usage_snapshot(tenant_id: str, *, now: float | None = None) -> dict[str, int]:
    """Optional local-only diagnostics; must never be labelled total API billing."""
    instant = time.time() if now is None else now
    day = datetime.fromtimestamp(instant, tz=timezone.utc).strftime("%Y-%m-%d")
    with _guard:
        return dict(_usage[(tenant_id, day)])
