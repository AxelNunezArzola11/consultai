"""
Real-Time Server-Sent Events (SSE) Event Broadcaster for the AI Operations Center.
Publishes operational events (agent handoffs, tool calls, execution status transitions,
pending approvals, and proposal updates) to connected Next.js / SSE clients.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Set


class ExecutionEventBroadcaster:
    """Thread-safe async pub/sub hub for live AI Operations Center streaming."""

    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue[Dict[str, Any]]] = set()

    async def publish(self, event_type: str, payload: Dict[str, Any]) -> None:
        event = {
            "event": event_type,
            "timestamp": datetime.utcnow().isoformat(),
            "data": payload,
        }
        stale: Set[asyncio.Queue[Dict[str, Any]]] = set()
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                stale.add(queue)
        for q in stale:
            self._subscribers.discard(q)

    async def subscribe(self) -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._subscribers.add(queue)
        try:
            # Emit initial connection handshake
            handshake = {
                "event": "connected",
                "timestamp": datetime.utcnow().isoformat(),
                "data": {"status": "streaming"},
            }
            yield f"data: {json.dumps(handshake)}\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(item)}\n\n"
                except asyncio.TimeoutError:
                    heartbeat = {
                        "event": "heartbeat",
                        "timestamp": datetime.utcnow().isoformat(),
                    }
                    yield f"data: {json.dumps(heartbeat)}\n\n"
        finally:
            self._subscribers.discard(queue)


broadcaster = ExecutionEventBroadcaster()
