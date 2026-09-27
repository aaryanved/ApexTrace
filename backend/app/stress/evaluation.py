"""
Headless evaluation on the shared StressRun engine.

- One scripted driver that follows the line and brakes ONLY in response to
  the warning actually displayed to it (so better/earlier warnings can change
  its braking; inputs are never replayed).
- Two suites built from the preset families: DEV (for any tuning) and
  HELD-OUT (different seeds + jitter; the garage and final comparisons use
  only this one). Acceptance is declared here, before any comparison.
- Paired experiments: clean, fault A, fault B, A+B, A+B+upgrade — same
  track, seed, start and disturbance schedule.
"""

from __future__ import annotations

import math
import os
import random
import threading
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from app import result_cache
from app.budget import config_label, enumerate_configs
from app.worker_guard import exit_with_parent
from app.f1_car import max_lateral_accel, steering_for_curvature
from app.placeholder_sim import TRACK_PRESETS, DemoVehicleState, loop_size, signed_clearance
from app.schemas import UpgradeConfig, UpgradeOption
from app.stress.run import TICK_DT, RunConfig, StressRun
from app.stress.spec import DriverConfig, StartConfig, StressScenario

HOLD_AFTER_M = 25.0
TARGET_MARGIN = 0.97
FRAME_EVERY_TICKS = 2  # 10 Hz replay frames
MIN_CLEARANCE_M = 0.5


class ScriptedDriver:
    """Pure-pursuit line following at a cruise speed; slows for a corner
    only after a displayed BRAKE warning plus its reaction delay."""

    def __init__(self, profile, cruise: float, reaction_s: float) -> None:
        self.centerline = profile.centerline
        self.n = loop_size(self.centerline)
        self.step = profile.total_length / self.n
        self.hazards = {h.id: h for h in profile.hazard_zones}
        self.cruise = cruise
        self.reaction_s = reaction_s
        self.pending: tuple[Any, float, float] | None = None
        self.latched: Any = None
        self.advised = 0.0
        self.ignored = 0
        self.log: list[dict[str, Any]] = []

    def on_warning(self, event: dict[str, Any], t: float, extra_delay_s: float, ignore_budget: int) -> None:
        if not event["active"] or event["hazard_id"] is None:
            return
        hazard = self.hazards[event["hazard_id"]]
        if self.latched is hazard or (self.pending is not None and self.pending[0] is hazard):
            return
        if self.ignored < ignore_budget:
            self.ignored += 1
            self.log.append({"type": "run_event", "event": "driver_ignored_warning", "t": round(t, 3),
                             "hazard_id": hazard.id, "note": "deliberate scripted noncompliance"})
            return
        self.pending = (hazard, t + self.reaction_s + extra_delay_s, event.get("advised_speed") or hazard.corner_speed)

    def control(self, v: DemoVehicleState, t: float, max_brake: float) -> tuple[float, float, float]:
        if self.pending and t >= self.pending[1]:
            self.latched, _, self.advised = self.pending
            self.pending = None
        if self.latched and (v.distance_along_lap % (self.n * self.step)) >= self.latched.end_distance + HOLD_AFTER_M \
                and (v.distance_along_lap % (self.n * self.step)) < self.latched.end_distance + 400:
            self.latched = None
        target = self.advised * TARGET_MARGIN if self.latched else self.cruise

        lookahead_m = 5.0 + 0.25 * v.speed
        ahead = max(1, math.ceil(lookahead_m / self.step))
        tx, ty = self.centerline[(v.nearest_point_index + ahead) % self.n]
        dx, dy = tx - v.x, ty - v.y
        alpha = (math.atan2(dy, dx) - v.heading + math.pi) % (2 * math.pi) - math.pi
        wanted = 2 * math.sin(alpha) / max(math.hypot(dx, dy), 1.0)
        steering = steering_for_curvature(v.speed, wanted)
        # Throttle and cornering share the rear tyres' grip: feed the power in
        # as the corner opens up instead of flooring it at the apex.
        lateral_use = min(1.0, v.speed * v.speed * abs(wanted) / max_lateral_accel(v.speed))
        power = 0.8 * max(0.1, 1.0 - lateral_use**2)

        error = target - v.speed
        if error < -0.3:
            return steering, 0.0, max_brake
        if error > 0.3:
            return steering, power, 0.0
        return steering, min(power, 0.3), 0.0


@dataclass
class RunOutput:
    result: dict[str, Any]
    frames: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    observations: list[dict[str, Any]] = field(default_factory=list)


def run_scenario(
    scenario: StressScenario,
    upgrades: UpgradeConfig | None = None,
    record: bool = False,
    observe: Callable[[StressRun, DemoVehicleState], dict[str, Any]] | None = None,
    test_id: str | None = None,
) -> RunOutput:
    profile = TRACK_PRESETS[scenario.track]
    run = StressRun(RunConfig(profile=profile, scenario=scenario, upgrades=upgrades or UpgradeConfig(),
                              seed=scenario.seed))
    driver = ScriptedDriver(profile, scenario.driver.cruise_speed_ms, scenario.driver.reaction_s)
    frames: list[dict[str, Any]] = []
    observations: list[dict[str, Any]] = []
    replay_observations: list[list[float]] = []
    start_distance = run.vehicle.distance_along_lap
    max_ticks = int(scenario.max_time_s / TICK_DT)
    controls = (0.0, 0.0, 0.0)
    for i in range(1, max_ticks + 1):
        e = run.effective
        controls = driver.control(run.vehicle, run.t + TICK_DT, e.driver_max_brake)
        events = run.tick(*controls)
        for ev in events:
            if ev["type"] == "warning_event":
                driver.on_warning(ev, run.t, run.effective.driver_extra_delay_s, run.effective.driver_ignore)
        v = run.vehicle
        if observe is not None:
            observations.append(observe(run, v))
        if record:
            from app.ml.features import vector

            replay_observations.append(vector(run.observation()))
        if record and i % FRAME_EVERY_TICKS == 0:
            tel = run.telemetry()
            shown = run.display.shown
            frames.append({
                "t": round(run.t, 3), "x": round(v.x, 3), "y": round(v.y, 3), "heading": round(v.heading, 4),
                "speed": round(v.speed, 3), "throttle": round(controls[1], 2), "brake": round(run.applied[1], 2),
                "distance": round(v.distance_along_lap, 2),
                "clearance": round(signed_clearance(v.x, v.y, profile, hint=v.nearest_point_index), 3),
                "warning_active": shown is not None and shown.state == "brake",
                "warning_state": "clear" if shown is None else shown.state,
                "track_exit": v.track_exit, "lap_complete": v.lap_complete,
                "true_grip": round(tel["true_grip"], 3), "estimated_grip": round(tel["estimated_grip"], 3),
                "sample_age_ms": None if tel["sample_age_ms"] is None else round(tel["sample_age_ms"], 1),
                "fallback_active": tel["local_fallback_active"],
                "active_faults": [f.spec.id for f in run.scheduler.active()],
            })
        done_segment = scenario.segment_length_m is not None and v.distance_along_lap - start_distance >= scenario.segment_length_m
        if v.track_exit or v.laps_completed >= scenario.laps or done_segment:
            break

    summary = run.summary()
    necessary = [w["margin_m"] for w in summary["warnings"] if w["necessary"]]
    completed = summary["lap_complete"] or (scenario.segment_length_m is not None and not summary["track_exit"])
    passed = (not summary["track_exit"]) and completed and (summary["min_clearance_m"] or 0) >= MIN_CLEARANCE_M
    result = {
        "exit_reason": ("hit the barrier" if summary.get("barrier_contacts") else "left the track") if summary["track_exit"] else None,
        "test_id": test_id or scenario.id,
        "scenario_id": scenario.id,
        "track": scenario.track,
        "passed": passed,
        "track_exit": summary["track_exit"],
        "completed": completed,
        "exit_location": summary["exit_location"],
        "min_clearance_m": summary["min_clearance_m"],
        "warnings": len(summary["warnings"]),
        "unnecessary_warnings": summary["unnecessary_warnings"],
        "min_warning_margin_m": min(necessary) if necessary else None,
        "stale_time_s": summary["stale_time_s"],
        "blackout_time_s": summary["blackout_time_s"],
        "fallback_first_t": summary["fallback_first_t"],
        "packets_rejected_old": summary["packets_rejected_old"],
        "barrier_contacts": summary["barrier_contacts"],
        "lap_time_s": summary["lap_time_s"],
        "driver_ignored": driver.ignored,
    }
    if record:
        from app.ml.risk import annotate_frames

        annotate_frames(frames, replay_observations)
    return RunOutput(result=result, frames=frames, events=run.events + driver.log, observations=observations)


# --------------------------------------------------------------------------
# suites


def _clean(track: str) -> StressScenario:
    return StressScenario(id=f"{track}_clean", name=f"{track.title()} — clean lap (no faults)", track=track, seed=1,
                          description="No faults: the baseline every other test is compared with.")


def families() -> list[StressScenario]:
    from app.scenarios import SCENARIOS

    # presets only: SAC-discovered scenarios are for the engineer to arm, and
    # must not silently change the fixed suite every time the search is rerun
    return [_clean("monza"), _clean("baku"), *(s for s in SCENARIOS.values() if s.source == "preset")]


def build_suite(kind: str) -> list[tuple[str, StressScenario]]:
    """DEV and HELD-OUT differ in seeds and jitter only; same families."""
    from app.scenarios import ScenarioOverrides, apply_overrides

    replicates, base = (2, 1000) if kind == "dev" else (3, 5000)
    suite = []
    for fam_i, fam in enumerate(families()):
        for r in range(1, replicates + 1):
            seed = base + fam_i * 17 + r
            rng = random.Random(seed)
            jittered = apply_overrides(fam, ScenarioOverrides(seed=seed, severity=rng.uniform(0.85, 1.15)))
            jittered = jittered.model_copy(update={
                "driver": DriverConfig(cruise_speed_ms=round(rng.uniform(80.0, 88.0), 1),
                                       reaction_s=round(rng.uniform(0.25, 0.40), 2)),
                "start": StartConfig(lateral_offset_m=round(rng.uniform(-1.0, 1.0), 2)),
            })
            suite.append((f"{fam.id}_{kind}{r}", jittered))
    return suite


SUITE_VERSION = "stress-v1"
SUITES = {"dev": build_suite("dev"), "heldout": build_suite("heldout")}


def suite_info(kind: str = "heldout") -> dict[str, Any]:
    return {
        "version": f"{SUITE_VERSION}-{kind}",
        "kind": kind,
        "acceptance": {"max_track_exits": 0, "min_clearance_m": MIN_CLEARANCE_M, "require_lap_complete": True},
        "tests": [
            {"id": tid, "scenario_id": s.id, "track": s.track, "name": s.name, "seed": s.seed,
             "description": s.description, "faults": [f.describe() for f in s.faults],
             "cruise_speed": s.driver.cruise_speed_ms, "reaction_s": s.driver.reaction_s}
            for tid, s in SUITES[kind]
        ],
    }


SUITE_GROUPS: dict[str, dict[str, Any]] = {
    "full": {"label": "Full stress suite (every family)", "families": None},
    "telemetry": {
        "label": "Telemetry & warning delivery",
        "families": ["monza_clean", "baku_clean", "monza_high_speed_blackout", "baku_stale_after_reconnect",
                     "baku_late_warning_delivery", "monza_fade_stale_speed", "recovery_test", "combined_moderate"],
    },
    "sensors": {
        "label": "Sensor faults",
        "families": ["monza_clean", "baku_clean", "baku_sensor_freeze", "baku_position_error",
                     "false_alarm_speed_overread", "shared_sensor_failure"],
    },
    "grip_brakes": {
        "label": "Grip & brakes",
        "families": ["monza_clean", "baku_clean", "monza_wet_braking", "monza_slow_brake_response",
                     "monza_fade_stale_speed", "combined_moderate"],
    },
}


def _low_priority() -> None:
    exit_with_parent()  # don't keep evaluating if the server is killed mid-run
    try:
        os.nice(10)
    except OSError:
        pass


def _eval_config(args: tuple[dict, str]) -> dict[str, Any]:
    option_dict, kind = args
    option = UpgradeOption.model_validate(option_dict)
    return {"option": option_dict,
            "tests": [run_scenario(s, option.upgrades, test_id=tid).result for tid, s in SUITES[kind]]}


def aggregate(option: dict[str, Any], results: list[dict[str, Any]]) -> dict[str, Any]:
    margins = [r["min_warning_margin_m"] for r in results if r["min_warning_margin_m"] is not None]
    return {
        "key": option["key"],
        "label": option["label"],
        "upgrades": option["upgrades"],
        "cost_cad": option["cost_cad"],
        "test_count": len(results),
        "track_exits": sum(r["track_exit"] for r in results),
        "min_clearance_m": min(r["min_clearance_m"] for r in results),
        "min_warning_margin_m": min(margins) if margins else None,
        "unnecessary_warnings": sum(r["unnecessary_warnings"] for r in results),
        "passed": all(r["passed"] for r in results),
        "failed_test_ids": [r["test_id"] for r in results if not r["passed"]],
        "tests": results,
    }


_CACHE: dict[str, dict[str, Any]] = {}


def evaluate_all(kind: str = "heldout", use_cache: bool = True, parallel: bool = True) -> dict[str, Any]:
    """Every upgrade combination on every test of the suite, then aggregated
    per suite group. Deterministic, so cached in memory and on disk (a
    restart reads the stored suite instead of re-running ~340 laps)."""
    if use_cache and kind in _CACHE:
        return _CACHE[kind]
    if not use_cache:
        return _evaluate_all(kind, parallel)
    response = result_cache.cached("evaluation", {"kind": kind}, lambda: _evaluate_all(kind, parallel))
    _CACHE[kind] = response
    return response


def _evaluate_all(kind: str, parallel: bool) -> dict[str, Any]:
    jobs = [(o.model_dump(), kind) for o in enumerate_configs()]
    raw = None
    if parallel:
        try:
            # leave two cores free and run at low priority, so a live driving
            # session (and the browser) stay smooth while the suite runs.
            # EVAL_WORKERS caps it on small hosted instances (Render).
            workers = int(os.environ.get("EVAL_WORKERS") or max(1, (os.cpu_count() or 4) - 2))
            with ProcessPoolExecutor(max_workers=workers, initializer=_low_priority) as pool:
                raw = list(pool.map(_eval_config, jobs))
        except Exception:
            raw = None
    if raw is None:
        raw = [_eval_config(j) for j in jobs]
    scenario_of = {tid: s.id for tid, s in SUITES[kind]}
    groups = {}
    passed_by_any = {t["test_id"] for r in raw for t in r["tests"] if t["passed"]}
    for gid, g in SUITE_GROUPS.items():
        fams = g["families"]
        keep = [tid for tid, _ in SUITES[kind] if fams is None or scenario_of[tid] in fams]
        # Tests that fail for EVERY configuration: no upgrade on offer changes them,
        # so they cannot inform the purchase. Computed from the results, not hand-picked.
        unsolved = [tid for tid in keep if tid not in passed_by_any]
        configs = [aggregate(r["option"], [t for t in r["tests"] if t["test_id"] in keep]) for r in raw]
        for c in configs:
            c["passed_solvable"] = all(t["passed"] for t in c["tests"] if t["test_id"] not in unsolved)
            c["solvable_passed_count"] = sum(t["passed"] for t in c["tests"] if t["test_id"] not in unsolved)
        groups[gid] = {
            "label": g["label"],
            "test_ids": keep,
            "unsolved_test_ids": unsolved,
            "solvable_count": len(keep) - len(unsolved),
            "configs": configs,
        }
    return {"suite": suite_info(kind), "groups": groups, "configs": groups["full"]["configs"]}


def find_test(test_id: str) -> StressScenario | None:
    for kind in ("heldout", "dev"):
        for tid, s in SUITES[kind]:
            if tid == test_id:
                return s
    return None


def replay(test_id: str, baseline: UpgradeConfig, upgraded: UpgradeConfig) -> dict[str, Any]:
    """Baseline vs upgraded run of one suite test, with 10 Hz frames. Deterministic
    (the TCN overlay too, when its models load), so cached in memory and on disk."""
    if find_test(test_id) is None:
        raise KeyError(test_id)
    return result_cache.cached("replay", _replay_key(test_id, baseline, upgraded),
                               lambda: _replay(test_id, baseline, upgraded))


def _replay_key(test_id: str, baseline: UpgradeConfig, upgraded: UpgradeConfig) -> dict[str, Any]:
    from app.ml import risk

    return {"test_id": test_id, "baseline": baseline.model_dump(mode="json"),
            "upgraded": upgraded.model_dump(mode="json"), "tcn": risk.status()["available"]}


def _replay(test_id: str, baseline: UpgradeConfig, upgraded: UpgradeConfig) -> dict[str, Any]:
    scenario = find_test(test_id)
    from app.ml import risk
    from app.ml.features import vector

    runs = {}
    for prefix, cfg in (("baseline", baseline), ("upgraded", upgraded)):
        observer = risk.new_observer()
        observe = (lambda run, v, o=observer: o.update(vector(run.observation()))) if observer else None
        out = run_scenario(scenario, cfg, record=True, test_id=test_id, observe=observe)
        if observer:
            for i, frame in enumerate(out.frames):
                pred = out.observations[(i + 1) * FRAME_EVERY_TICKS - 1]
                frame["tcn_risk"] = None if pred is None else round(pred["risk"], 4)
                frame["tcn_clearance"] = None if pred is None else round(pred["clearance"], 3)
                frame["tcn_spread"] = None if pred is None else round(pred["spread"], 4)
        name = config_label(cfg)
        label = name if name.lower().startswith(prefix) else f"{prefix.title()}: {name}"
        runs[prefix] = {"label": label, "upgrades": cfg.model_dump(), "result": out.result,
                        "frames": out.frames, "events": out.events}
    info = next(t for t in suite_info("heldout" if any(t == test_id for t, _ in SUITES["heldout"]) else "dev")["tests"]
                if t["id"] == test_id)
    return {"test": info, **runs}


def paired(scenario: StressScenario, upgrade: UpgradeConfig) -> dict[str, Any]:
    """Clean, A alone, B alone, A+B, A+B+upgrade — identical track, seed,
    start, driver and disturbance schedule; only the listed faults differ."""
    a, b = scenario.faults[:1], scenario.faults[1:]
    variants = [
        ("clean", "Clean baseline", [], UpgradeConfig()),
        ("a", f"A alone: {a[0].describe()}" if a else "A (none)", a, UpgradeConfig()),
    ]
    if b:
        variants.append(("b", "B alone: " + "; ".join(f.describe() for f in b), b, UpgradeConfig()))
        variants.append(("ab", "A + B together", a + b, UpgradeConfig()))
    variants.append(("ab_upgrade" if b else "a_upgrade", f"{'A + B' if b else 'A'} with {config_label(upgrade)}", a + b, upgrade))
    rows = []
    for key, label, faults, cfg in variants:
        s = scenario.model_copy(update={"faults": faults})
        out = run_scenario(s, cfg, test_id=f"{scenario.id}:{key}")
        rows.append({"key": key, "label": label, "upgrades": cfg.model_dump(), "result": out.result})
    return {"scenario_id": scenario.id, "scenario_name": scenario.name, "seed": scenario.seed, "rows": rows}


# --------------------------------------------------------------------------
# replay pre-warming


def default_test(baseline: list[dict[str, Any]], upgraded: list[dict[str, Any]]) -> str | None:
    """The test the Compare screen opens first (mirrors pickDefaultTest in
    frontend/src/compare/compareLogic.ts): the tightest test the upgrade fixes,
    else the tightest baseline failure, else the tightest test overall."""
    def tightest(tests: list[dict[str, Any]]) -> str:
        return min(tests, key=lambda t: t["min_clearance_m"])["test_id"]

    if not baseline:
        return None
    passed_upgraded = {t["test_id"] for t in upgraded if t["passed"]}
    fixed = [t for t in baseline if not t["passed"] and t["test_id"] in passed_upgraded]
    failed = [t for t in baseline if not t["passed"]]
    return tightest(fixed or failed or baseline)


def replay_warm_order(kind: str = "heldout") -> list[tuple[str, dict[str, Any]]]:
    """Every (test, upgrade set) the Compare screen can ask for (always against
    no upgrades), most likely first: each set's default test, then the tests
    the baseline fails, then the rest."""
    configs = evaluate_all(kind)["configs"]
    base = next(c for c in configs if not any(c["upgrades"].values()))
    others = [c for c in configs if c is not base]
    failing = sorted(base["tests"], key=lambda t: (t["passed"], t["min_clearance_m"]))
    ordered = [(default_test(base["tests"], c["tests"]), c["upgrades"]) for c in others]
    ordered += [(t["test_id"], c["upgrades"]) for t in failing for c in others]
    seen, jobs = set(), []
    for test_id, upgrades in ordered:
        mark = (test_id, tuple(sorted(upgrades.items())))
        if test_id is not None and mark not in seen:
            seen.add(mark)
            jobs.append((test_id, upgrades))
    return jobs


def _warm_replay(job: tuple[str, dict[str, Any]]) -> None:
    test_id, upgrades = job
    replay(test_id, UpgradeConfig(), UpgradeConfig.model_validate(upgrades))  # stored on disk by the cache


def prewarm_replays(kind: str = "heldout", stop: threading.Event | None = None) -> int:
    """Compute and store every Compare replay not yet cached, one at a time in a
    single low-priority worker process (a thread here would compete with live
    sessions for the GIL). Checks `stop` between replays; returns how many ran."""
    if not result_cache.enabled() or os.environ.get("LIMITLAB_PREWARM", "1") == "0":
        return 0
    jobs = [(tid, up) for tid, up in replay_warm_order(kind)
            if not result_cache.contains("replay", _replay_key(tid, UpgradeConfig(), UpgradeConfig.model_validate(up)))]
    done = 0
    if jobs:
        with ProcessPoolExecutor(max_workers=1, initializer=_low_priority) as pool:
            for job in jobs:
                if stop is not None and stop.is_set():
                    break
                pool.submit(_warm_replay, job).result()
                done += 1
    return done
