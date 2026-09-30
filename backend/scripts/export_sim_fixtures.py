"""Export what the browser simulator (frontend/src/sim) is ported from and tested against.

    python scripts/export_sim_fixtures.py

Writes, under frontend/src/sim/:
  tracks/<id>.json               the track profiles (TRACK_PRESETS)
  __fixtures__/steps_<name>.json  single vehicle steps: state before, inputs, state after
  __fixtures__/session_<name>.json whole live sessions: per-tick inputs and every message sent

The single steps test the physics exactly (no divergence can build up); the
sessions test the full tick (pipeline, warnings, laps, messages) over a run.
"""

from __future__ import annotations

import gzip
import json
import math
from dataclasses import asdict
from pathlib import Path

import _path  # noqa: F401

from app.f1_car import CarSetup, DriverRequests
from app.placeholder_sim import TRACK_PRESETS, step
from app.schemas import CarSetupConfig
from app.session_state import Session
from app.stress.evaluation import ScriptedDriver

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "sim"


def dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, separators=(",", ":"))
    if path.suffix == ".gz":
        path.write_bytes(gzip.compress(text.encode(), mtime=0))
    else:
        path.write_text(text)
    print(f"{path.relative_to(OUT.parents[2])}: {path.stat().st_size // 1024} KB")


def clean(value):
    """JSON-safe: infinities become null (never expected in these fields)."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


# ------------------------------------------------------------------ inputs


def scripted_inputs(profile, ticks: int, cruise: float, session: Session):
    """Pure-pursuit driver reacting to the live warnings (drives real laps)."""
    driver = ScriptedDriver(profile, cruise=cruise, reaction_s=0.4)

    def next_input(i, messages):
        for m in messages:
            if m["type"] == "warning_event":
                driver.on_warning(m, session.run.t, 0.0, 0)
        s, th, br = driver.control(session.run.vehicle, session.run.t, 1.0)
        return {"steering": s, "throttle": th, "brake": br}

    return next_input


def raw_inputs(i, _messages):
    """Flat out with no steering into the first wall, a stop, holding the brake
    at standstill (automatic reverse), reversing, then steering sweeps."""
    if i < 260:
        return {"steering": 0.0, "throttle": 1.0, "brake": 0.0}
    if i < 320:
        return {"steering": 0.0, "throttle": 0.0, "brake": 1.0}
    if i < 380:
        return {"steering": 0.6, "throttle": 0.0, "brake": 1.0}  # brake pedal drives reverse
    if i < 420:
        return {"steering": 0.0, "throttle": 0.6, "brake": 0.0}  # throttle: back to drive
    return {"steering": math.sin(i / 9.0), "throttle": 0.7, "brake": 0.2 if i % 50 < 10 else 0.0}


def manual_inputs(i, _messages):
    """Manual gearbox and DRS: shifts and toggles as running button totals."""
    return {
        "steering": 0.15 * math.sin(i / 30.0),
        "throttle": 1.0 if (i // 80) % 3 else 0.0,
        "brake": 0.0 if (i // 80) % 3 else 0.8,
        "shift_up_count": i // 25 if (i // 80) % 3 else (i // 80) * 3,
        "shift_down_count": i // 40,
        "drs_toggle_count": i // 60,
        "reverse_toggle_count": 0,
    }


# ------------------------------------------------------------------ recorders


def record_session(name: str, track: str, ticks: int, setup: dict, inputs, scripted_cruise: float | None = None,
                   pause_at: tuple[int, int] | None = None, reset_at: int | None = None) -> None:
    profile = TRACK_PRESETS[track]
    session = Session(session_id="fixture", track_profile=profile, setup=CarSetupConfig(**setup))
    session.run.config.setup = CarSetup(**setup)
    if scripted_cruise is not None:
        inputs = scripted_inputs(profile, ticks, scripted_cruise, session)
    rows = []
    messages: list = []
    totals = {"shift_up": 0, "shift_down": 0, "drs_toggle": 0, "reverse_toggle": 0}
    for i in range(ticks):
        command = inputs(i, messages)
        # the same button-total bookkeeping as apply_message(control_input)
        for key in totals:
            total = command.get(f"{key}_count", 0)
            if i > 0 and total > totals[key]:
                session.pending_buttons[key] = session.pending_buttons.get(key, 0) + min(total - totals[key], 3)
            totals[key] = total
        session.control = {"steering": max(-1.0, min(1.0, command["steering"])),
                           "throttle": max(0.0, min(1.0, command["throttle"])),
                           "brake": max(0.0, min(1.0, command["brake"]))}
        control = {"type": None}
        if pause_at and i == pause_at[0]:
            session.running, control = False, {"type": "pause"}
        if pause_at and i == pause_at[1]:
            session.running, control = True, {"type": "resume"}
        if reset_at is not None and i == reset_at:
            session.reset_run()
            control = {"type": "reset"}
        messages = session.tick(now=float(i))
        rows.append({"input": {**command, **({"command": control["type"]} if control["type"] else {})},
                     "messages": [m for m in messages if m["type"] in ("vehicle_state", "warning_event", "run_event")]})
    for row in rows:
        for m in row["messages"]:
            m.pop("packet_age_ms", None)  # wall-clock dependent
            for key in ("tcn_risk", "tcn_clearance", "tcn_spread"):
                m.pop(key, None)
    dump(OUT / "__fixtures__" / f"session_{name}.json.gz",
         clean({"track": track, "setup": setup, "ticks": rows}))


def record_steps(name: str, track: str, setup: dict, session_name: str, count: int = 600) -> None:
    """Replays a recorded session's inputs through `step` directly and stores
    (before, inputs, after) for single-step equivalence tests."""
    profile = TRACK_PRESETS[track]
    cs = CarSetup(**setup)
    data = json.loads(gzip.decompress((OUT / "__fixtures__" / f"session_{session_name}.json.gz").read_bytes()))
    session = Session(session_id="steps", track_profile=profile, setup=CarSetupConfig(**setup))
    run = session.run
    out = []
    totals = {"shift_up": 0, "shift_down": 0, "drs_toggle": 0, "reverse_toggle": 0}
    stride = max(1, len(data["ticks"]) // count)
    for i, row in enumerate(data["ticks"]):
        command = row["input"]
        requests = {}
        for key in totals:
            total = command.get(f"{key}_count", 0)
            requests[key] = min(total - totals[key], 3) if i > 0 and total > totals[key] else 0
            totals[key] = total
        v = run.vehicle
        steering = max(-1.0, min(1.0, command["steering"]))
        throttle = max(0.0, min(1.0, command["throttle"]))
        brake = max(0.0, min(1.0, command["brake"]))
        after = step(v, steering, throttle, brake, 0.05, profile, grip=1.0, brake_wear=run.config.brake_wear(),
                     setup=cs, requests=DriverRequests(**requests))
        if i % stride == 0:
            out.append({"before": asdict(v), "steering": steering, "throttle": throttle, "brake": brake,
                        "requests": requests, "brake_wear": run.config.brake_wear(), "after": asdict(after)})
        run.vehicle = after
    dump(OUT / "__fixtures__" / f"steps_{name}.json.gz", clean({"track": track, "setup": setup, "steps": out}))


if __name__ == "__main__":
    for tid, profile in TRACK_PRESETS.items():
        dump(OUT / "tracks" / f"{tid}.json", profile.model_dump(mode="json"))

    default = CarSetupConfig().model_dump()
    loose = {**default, "traction_control": "off", "abs": False, "ers_mode": "overtake"}
    manual = {**default, "gearbox": "manual", "drs_mode": "manual", "ers_mode": "harvest", "traction_control": "medium"}

    record_session("monza_lap", "monza", 2700, default, None, scripted_cruise=80.0, pause_at=(2500, 2540))
    record_session("baku_lap", "baku", 3400, default, None, scripted_cruise=62.0, reset_at=3300)
    record_session("monza_loose", "monza", 1200, loose, None, scripted_cruise=75.0)
    record_session("monza_raw", "monza", 700, default, raw_inputs)
    record_session("baku_manual", "baku", 600, manual, manual_inputs)

    record_steps("monza_lap", "monza", default, "monza_lap")
    record_steps("baku_lap", "baku", default, "baku_lap")
    record_steps("monza_loose", "monza", loose, "monza_loose")
    record_steps("monza_raw", "monza", default, "monza_raw")
    record_steps("baku_manual", "baku", manual, "baku_manual")
