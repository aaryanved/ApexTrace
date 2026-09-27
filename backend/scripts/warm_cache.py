"""Fill the result cache (evaluation suite + Compare replays) ahead of time.

    python scripts/warm_cache.py

The server does the same warm-up on start, but on a small hosted instance
that competes with live sessions for CPU for many minutes after every boot.
Run at build time (render.yaml) instead, the cache ships with the deploy and
the start-up warm-up finds nothing left to do.
"""

from __future__ import annotations

import threading
import time

import _path  # noqa: F401

from app.stress import evaluation

if __name__ == "__main__":
    start = time.monotonic()
    evaluation.evaluate_all("heldout")
    print(f"evaluation cached in {time.monotonic() - start:.0f}s", flush=True)
    start = time.monotonic()
    count = evaluation.prewarm_replays("heldout", threading.Event())
    print(f"{count} replays cached in {time.monotonic() - start:.0f}s", flush=True)
