import asyncio
import multiprocessing
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api.live import router as live_router
from app.api.simulation import router as simulation_router
from app.evaluation_routes import router as evaluation_router
from app.leaderboard import router as leaderboard_router
from app.scenarios import router as scenarios_router
from app.schemas import HealthStatus
from app.sessions import router as sessions_router
from app.sessions import sweep_loop
from app.stress import evaluation

# Lap-simulator AI routes need the optional ML stack (requirements-ml.txt).
# Without it the rest of the API still runs, like the TCN risk observer.
try:
    from app.api.ai import router as ai_router
except ImportError:  # torch / optuna not installed
    ai_router = None

# Worker pools started by this server (the start-up evaluation warm-up, batch
# simulation) must not be forked from it: a forked worker is a copy of this
# process, listening socket included, so if the server is stopped mid-run
# (e.g. Ctrl+C during the warm-up) the orphaned workers keep port 8000 bound
# and the next start fails with "address already in use". Spawned workers
# start as fresh interpreters with no inherited socket (and, via
# app.worker_guard, quit when the server dies instead of computing on for
# minutes). Offline scripts don't import this module.
multiprocessing.set_start_method("spawn", force=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    sweeper = asyncio.create_task(sweep_loop())
    stop = threading.Event()

    async def warm() -> None:
        # Warm the (deterministic, disk-cached) evaluation so the first click is
        # instant, then precompute the Compare replays in the background. Both
        # are no-ops once stored, until the code or data changes.
        await asyncio.to_thread(evaluation.evaluate_all, "heldout")
        await asyncio.to_thread(evaluation.prewarm_replays, "heldout", stop)

    warmup = asyncio.create_task(warm())
    yield
    stop.set()
    sweeper.cancel()
    warmup.cancel()


app = FastAPI(title="LimitLab API", lifespan=lifespan)

# Local demo only: the page may be served from localhost or from the driver
# laptop's LAN address (engineer station on a second device).
LOCAL_ORIGIN_REGEX = (
    r"http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+"
    r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?"
)
# Hosted deploy: the frontend's origin(s), e.g. the Vercel URLs.
EXTRA_ORIGIN_REGEX = os.environ.get("CORS_ORIGIN_REGEX")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        f"(?:{LOCAL_ORIGIN_REGEX})|(?:{EXTRA_ORIGIN_REGEX})" if EXTRA_ORIGIN_REGEX else LOCAL_ORIGIN_REGEX
    ),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Replays and the evaluation are 0.1-1 MB of JSON; compressed ~10x, which
# matters for the engineer device on Wi-Fi. WebSockets are unaffected.
app.add_middleware(GZipMiddleware, minimum_size=2048)

app.include_router(sessions_router)
app.include_router(scenarios_router)
app.include_router(evaluation_router)
app.include_router(leaderboard_router)


@app.get("/health", response_model=HealthStatus)
def health() -> HealthStatus:
    return HealthStatus(status="ok", service="limitlab-backend")


# Lap simulator (deterministic scenario runs, replays, configuration comparison, AI search).
app.include_router(simulation_router)
app.include_router(live_router)
if ai_router is not None:
    app.include_router(ai_router)
