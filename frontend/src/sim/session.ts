// One live driving session, run in the browser: the car, the warning
// pipeline and lap state, stepped at 20 Hz. It produces the same messages the
// Python server used to stream (backend/app/session_state.py and
// stress/run.py, see git history), so the Drive screen reads them unchanged.

import type {
  CarSetupConfig,
  RunEventMessage,
  SessionInfoMessage,
  TrackProfile,
  VehicleStateMessage,
  WarningEventMessage,
} from '../types/schemas'
import { CAR, NO_REQUESTS, type DriverRequests } from './car'
import { DriverDisplay, Link, Sensors, WarningService, type Decision, type Packet } from './pipeline'
import { clamp, pyFormat0, pyMod, pyRound } from './pyMath'
import {
  distanceToHazard,
  initialState,
  nextHazardZone,
  sectorAt,
  signedClearance,
  signedLateral,
  step,
  surfaceAt,
  type VehicleState,
} from './vehicle'

export const TICK_DT = 0.05
// The car's brakes are not new: 75 % effective (the Python model's baseline car).
const BRAKE_WEAR = 0.75

export type SimMessage = VehicleStateMessage | WarningEventMessage | RunEventMessage | SessionInfoMessage

export interface ControlInput {
  steering: number
  throttle: number
  brake: number
  // running totals of button presses; the session acts on the increase
  shift_up_count?: number
  shift_down_count?: number
  drs_toggle_count?: number
  reverse_toggle_count?: number
}

const BUTTONS = ['shift_up', 'shift_down', 'drs_toggle', 'reverse_toggle'] as const
type Button = (typeof BUTTONS)[number]

const newRunId = () => Math.random().toString(16).slice(2, 10)

/** One run: the true world, the warning pipeline and the lap/exit bookkeeping. */
class Run {
  t = 0.0
  vehicle: VehicleState
  private sensors = new Sensors()
  private uplink = new Link<Packet>()
  private downlink = new Link<Decision>()
  private remote: WarningService
  private display = new DriverDisplay()
  private exitT: number | null = null
  private shownKey: string | null = null
  private warningSeq = 0
  private readonly profile: TrackProfile

  constructor(profile: TrackProfile) {
    this.profile = profile
    this.vehicle = initialState(profile)
    this.remote = new WarningService(profile)
  }

  tick(steering: number, throttle: number, brake: number, setup: CarSetupConfig, advance: boolean, requests: DriverRequests) {
    const events: (WarningEventMessage | RunEventMessage)[] = []
    if (advance) this.t += TICK_DT
    const t = this.t

    // actual world: vehicle dynamics
    if (advance) {
      this.vehicle = step(this.vehicle, steering, throttle, brake, TICK_DT, this.profile, {
        brakeWear: BRAKE_WEAR,
        setup,
        requests,
      })
      this.sensors.estimate(1.0, TICK_DT)
    }
    const v = this.vehicle

    // sensors -> uplink -> remote service -> downlink -> display
    if (advance) {
      const packet = this.sensors.sample(t, v, signedLateral(v.x, v.y, v.nearest_point_index, this.profile))
      if (packet !== null) this.uplink.send(packet)
    }
    for (const packet of this.uplink.deliver()) this.remote.receive(packet)
    this.downlink.send(this.remote.decide(t))
    for (const d of this.downlink.deliver()) this.display.receiveRemote(d)
    const shown = this.display.resolve(t)

    if (v.track_exit && this.exitT === null) {
      this.exitT = t
      events.push({ type: 'run_event', event: 'track_exit', t: pyRound(t, 3), distance: pyRound(v.distance_along_lap, 1), location: this.exitLocation(v.distance_along_lap) })
    }

    // warning display changes
    const key = shown === null ? null : `${shown.state}|${shown.hazard_id}|${shown.source}`
    if (key !== this.shownKey) {
      this.shownKey = key
      this.warningSeq += 1
      events.push(this.warningEvent(shown))
    }
    return events
  }

  private exitLocation(distance: number): string {
    const d = pyMod(distance, this.profile.total_length)
    const near = this.profile.hazard_zones.find((h) => h.start_distance - 150 <= d && d <= h.end_distance + 50)
    return near ? near.label : `${pyFormat0(d)} m`
  }

  private warningEvent(shown: Decision | null): WarningEventMessage {
    return {
      type: 'warning_event',
      seq: this.warningSeq,
      active: shown !== null && shown.state === 'brake',
      state: shown === null ? 'clear' : shown.state,
      reason: shown === null ? null : shown.reason,
      hazard_zone: shown === null ? null : shown.hazard_label,
      hazard_id: shown === null ? null : shown.hazard_id,
      advised_speed: shown === null ? null : shown.advised_speed,
      source: shown === null ? null : shown.source,
      data_age_ms: shown === null || shown.data_age_ms === null ? null : pyRound(shown.data_age_ms, 1),
      generated_t: shown === null ? null : pyRound(shown.generated_t, 3),
      displayed_t: pyRound(this.t, 3),
      source_t: pyRound(this.t, 3),
    }
  }

  /** Per-tick fields the driver's HUD shows. */
  telemetry() {
    const v = this.vehicle
    const profile = this.profile
    const sector = sectorAt(v.distance_along_lap, profile)
    const hazard = nextHazardZone(v.distance_along_lap, profile)
    const shown = this.display.shown
    return {
      sector_index: sector.index,
      sector_name: sector.name,
      next_hazard_zone: hazard ? hazard.label : null,
      next_hazard_distance: hazard ? distanceToHazard(v.distance_along_lap, hazard, profile) : null,
      signed_clearance: signedClearance(v.x, v.y, profile, v.nearest_point_index),
      sample_age_ms: this.remote.dataAgeMs(this.t),
      warning_reason: shown === null || shown.state === 'clear' ? null : shown.reason,
      warning_state: shown === null ? ('clear' as const) : shown.state,
      true_grip: 1.0,
      estimated_grip: this.sensors.gripEstimate,
    }
  }
}

export class SimSession {
  readonly sessionId = newRunId()
  runId = newRunId()
  running = true
  setup: CarSetupConfig
  private run: Run
  private control = { steering: 0.0, throttle: 0.0, brake: 0.0 }
  // button presses: last running totals seen, and the increase not yet handed to the physics
  private buttonTotals: Partial<Record<Button, number>> = {}
  private pendingButtons: Partial<Record<Button, number>> = {}
  private sessionBestLap: number | null = null
  private outbox: SimMessage[] = []
  readonly profile: TrackProfile

  constructor(profile: TrackProfile, setup: CarSetupConfig) {
    this.profile = profile
    this.setup = setup
    this.run = new Run(profile)
    this.queueSessionInfo()
  }

  // -- commands --------------------------------------------------------------

  setControls(input: ControlInput): void {
    this.control = {
      steering: clamp(input.steering, -1.0, 1.0),
      throttle: clamp(input.throttle, 0.0, 1.0),
      brake: clamp(input.brake, 0.0, 1.0),
    }
    for (const key of BUTTONS) {
      const total = input[`${key}_count`] ?? 0
      const seen = this.buttonTotals[key]
      // the first input (or a reload that restarted the count) only sets the baseline
      if (seen !== undefined && total > seen) this.pendingButtons[key] = (this.pendingButtons[key] ?? 0) + Math.min(total - seen, 3)
      this.buttonTotals[key] = total
    }
  }

  setSetup(setup: CarSetupConfig): void {
    this.setup = setup
  }

  pause(): void {
    this.running = false
  }

  resume(): void {
    this.running = true
  }

  /** Back to the start: fresh car, pipeline and lap state. */
  reset(): void {
    this.running = true
    this.runId = newRunId()
    this.run = new Run(this.profile)
    this.queueSessionInfo()
  }

  // -- ticking ---------------------------------------------------------------

  /** Advance one 50 ms step; returns the messages it produced. */
  tick(): SimMessage[] {
    const b = this.pendingButtons
    this.pendingButtons = {}
    const requests: DriverRequests = this.running
      ? { shift_up: b.shift_up ?? 0, shift_down: b.shift_down ?? 0, drs_toggle: b.drs_toggle ?? 0, reverse_toggle: b.reverse_toggle ?? 0 }
      : NO_REQUESTS
    const c = this.control
    const events = this.run.tick(c.steering, c.throttle, c.brake, this.setup, this.running, requests)
    const best = this.run.vehicle.best_lap_time
    if (best !== null && (this.sessionBestLap === null || best < this.sessionBestLap)) this.sessionBestLap = best
    const messages = this.outbox
    this.outbox = []
    messages.push(...events, this.vehicleStateMessage())
    return messages
  }

  private queueSessionInfo(): void {
    this.outbox.push({ type: 'session_info', session_id: this.sessionId, run_id: this.runId, track: this.profile.id })
  }

  private vehicleStateMessage(): VehicleStateMessage {
    const run = this.run
    const v = run.vehicle
    const profile = this.profile
    const tel = run.telemetry()
    return {
      type: 'vehicle_state',
      seq: v.seq,
      t: pyRound(run.t, 3),
      x: v.x,
      y: v.y,
      heading: v.heading,
      speed: v.speed,
      lap_progress: pyMod(v.distance_along_lap, profile.total_length) / profile.total_length,
      distance_along_lap: v.distance_along_lap,
      track_exit: v.track_exit,
      lap_complete: v.lap_complete,
      off_track: v.off_track,
      track_exits: v.track_exits,
      barrier_contacts: v.barrier_contacts,
      lap: v.laps_completed + 1,
      laps_completed: v.laps_completed,
      lap_time_s: v.lap_time,
      last_lap_s: v.last_lap_time,
      best_lap_s: v.best_lap_time,
      session_best_lap_s: this.sessionBestLap,
      lap_valid: v.lap_clean,
      last_lap_valid: v.last_lap_valid,
      gear: v.gear,
      rpm: v.rpm,
      battery_pct: (100.0 * v.battery) / CAR.battery_capacity,
      ers_deploy_kw: v.ers_deploy_kw,
      drs_open: v.drs_open,
      drs_available: v.drs_available,
      tc_active: v.tc_cut > 0.03,
      wheelspin: v.wheelspin,
      lockup: v.front_lock || v.rear_lock,
      // what the wheels are on, for rumble and dust on the Drive screen
      surface: surfaceAt(tel.signed_clearance, v.distance_along_lap, profile),
      g_lat: v.ay / 9.81,
      g_long: v.ax / 9.81,
      setup: this.setup,
      ...tel,
    }
  }
}
