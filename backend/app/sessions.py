from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket
from starlette.websockets import WebSocketDisconnect

from app.placeholder_sim import TRACK_PRESETS
from app.schemas import (
    SessionCreateRequest,
    SessionCreateResponse,
    SessionJoinRequest,
    SessionJoinResponse,
    SessionRole,
    TrackId,
    TrackProfile,
    TrackProfileSummary,
)
from app.session_state import TICK_DT, Session, handle_raw_message

HEARTBEAT_SECONDS = 1.0
SESSION_TTL_SECONDS = 300.0
SWEEP_INTERVAL_SECONDS = 30.0

SESSIONS: dict[str, Session] = {}

router = APIRouter()


def cleanup_stale_sessions(now: float | None = None, ttl: float = SESSION_TTL_SECONDS) -> list[str]:
    """Drops sessions nobody is connected to and nobody has touched for `ttl`."""
    now = time.monotonic() if now is None else now
    removed = []
    for session_id, session in list(SESSIONS.items()):
        if not session.clients and now - session.last_active > ttl:
            del SESSIONS[session_id]
            removed.append(session_id)
    return removed


async def sweep_loop() -> None:
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
        cleanup_stale_sessions()


@router.get("/tracks", response_model=list[TrackProfileSummary])
def list_tracks() -> list[TrackProfileSummary]:
    return [
        TrackProfileSummary(
            id=profile.id,
            name=profile.name,
            total_length=profile.total_length,
            track_width=profile.track_width,
            sector_count=len(profile.sectors),
            hazard_zone_count=len(profile.hazard_zones),
        )
        for profile in TRACK_PRESETS.values()
    ]


@router.get("/tracks/{track_id}", response_model=TrackProfile)
def get_track(track_id: TrackId) -> TrackProfile:
    return TRACK_PRESETS[track_id]


@router.post("/sessions", response_model=SessionCreateResponse)
def create_session(body: SessionCreateRequest) -> SessionCreateResponse:
    track_profile = TRACK_PRESETS[body.track]
    session_id = uuid.uuid4().hex[:8]
    seed = body.seed if body.seed is not None else track_profile.seed
    session = Session(
        session_id=session_id,
        track_profile=track_profile,
        seed=seed,
        upgrades=body.upgrades,
        setup=body.setup,
    )
    SESSIONS[session_id] = session
    return SessionCreateResponse(
        session_id=session_id,
        role=body.role,
        run_id=session.run_id,
        seed=session.seed,
        track_profile=track_profile,
    )


@router.post("/sessions/{session_id}/join", response_model=SessionJoinResponse)
def join_session(session_id: str, body: SessionJoinRequest) -> SessionJoinResponse:
    session = SESSIONS.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    session.touch()
    return SessionJoinResponse(
        session_id=session_id,
        role=body.role,
        run_id=session.run_id,
        seed=session.seed,
        track_profile=session.track_profile,
    )


async def broadcast(session: Session, messages: list[dict[str, Any]]) -> None:
    for websocket in list(session.clients):
        try:
            for message in messages:
                await websocket.send_json(message)
        except Exception:
            session.clients.pop(websocket, None)


async def run_session_loop(session: Session) -> None:
    last_heartbeat = 0.0
    # Sleep to the next deadline, not a fixed TICK_DT after the work: otherwise
    # tick + broadcast time adds to every period and on a slow host (the free
    # Render instance) the stream drops well below 20 Hz.
    deadline = time.monotonic()
    while session.clients:
        deadline += TICK_DT
        delay = deadline - time.monotonic()
        if delay < -TICK_DT:  # fell far behind (stall): resync instead of bursting
            deadline = time.monotonic()
            delay = 0
        await asyncio.sleep(max(0.0, delay))
        now = time.monotonic()
        session.touch(now)
        messages = session.tick(now)
        if now - last_heartbeat >= HEARTBEAT_SECONDS:
            last_heartbeat = now
            messages.append({"type": "heartbeat", "t": now - session.start_time})
        await broadcast(session, messages)


def ensure_loop(session: Session) -> None:
    if session.loop_task is None or session.loop_task.done():
        session.loop_task = asyncio.create_task(run_session_loop(session))


async def serve_client(websocket: WebSocket, session_id: str, role: SessionRole) -> None:
    session = SESSIONS.get(session_id)
    if session is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    session.clients[websocket] = role
    if role == "engineer":
        session.engineer_ever_connected = True
    session.touch()
    session.queue_session_info()
    ensure_loop(session)

    # A (re)connecting client gets the full current picture immediately.
    try:
        await websocket.send_json(session.session_info())
        await websocket.send_json(session.fault_state_message())
    except Exception:
        session.clients.pop(websocket, None)
        return

    try:
        while True:
            text = await websocket.receive_text()
            session.touch()
            for reply in handle_raw_message(session, role, text):
                await websocket.send_json(reply)
    except WebSocketDisconnect:
        pass
    finally:
        session.clients.pop(websocket, None)
        session.touch()
        session.queue_session_info()


@router.websocket("/ws/driver/{session_id}")
async def driver_ws(websocket: WebSocket, session_id: str) -> None:
    await serve_client(websocket, session_id, "driver")


@router.websocket("/ws/engineer/{session_id}")
async def engineer_ws(websocket: WebSocket, session_id: str) -> None:
    await serve_client(websocket, session_id, "engineer")
