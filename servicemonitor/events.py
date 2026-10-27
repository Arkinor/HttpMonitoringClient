"""In-process event bus for Server-Sent Events."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from servicemonitor import config

log = config.get_logger(__name__)

_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()


def subscribe() -> asyncio.Queue[dict[str, Any]]:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
    _subscribers.add(queue)
    return queue


def unsubscribe(queue: asyncio.Queue[dict[str, Any]]) -> None:
    _subscribers.discard(queue)


def publish(event: dict[str, Any]) -> None:
    for queue in list(_subscribers):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            log.warning("SSE queue is full, dropping event %s", event.get("type"))


def format_sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def subscriber_count() -> int:
    return len(_subscribers)
