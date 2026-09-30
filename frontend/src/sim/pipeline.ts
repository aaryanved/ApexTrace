// The BRAKE warning's data path, per tick:
//
//   true state -> sensors (sample rate, grip estimator)
//   sensor packets -> uplink -> remote warning service
//   remote decisions -> downlink -> driver display
//
// The warning service only ever sees sensor channels, each carrying its own
// sample time, so stale data is detectable. Nothing downstream of the sensors
// reads the true speed or grip. Ported from the Python pipeline
// (backend/app/stress/pipeline.py, see git history) without its fault
// injection: every link here is healthy, so packets arrive the same tick.

import type { HazardZone, TrackProfile } from '../types/schemas'
import { pyFormat0, pyMod } from './pyMath'
import { distanceToHazard, type VehicleState } from './vehicle'

const CHANNELS = ['speed', 'position', 'grip'] as const
type Channel = (typeof CHANNELS)[number]
const BASE_ESTIMATOR_TAU_S = 1.0
const SAMPLE_RATE_HZ = 20.0

/** The safety system: the braking-warning rule and its data-freshness limits. */
export const POLICY = {
  reaction_allowance_s: 0.35,
  margin_m: 7.0,
  stale_threshold_ms: 300.0,
  lookahead_m: 1500.0,
  nominal_brake_decel: 32.0, // ~3.3 g: representative of the 2026 car
} as const

// ------------------------------------------------------------------ sensors

export interface Packet {
  seq: number
  sent_t: number
  channels: Record<Channel, [number, number]> // name -> (value, sample_time)
  lateral: number
  yaw_rate: number
}

export class Sensors {
  seq = 0
  lastSampleT = -1e9
  gripEstimate = 1.0
  lastHeading: number | null = null

  estimate(trueGrip: number, dt: number): void {
    this.gripEstimate += (trueGrip - this.gripEstimate) * (1 - Math.exp(-dt / BASE_ESTIMATOR_TAU_S))
  }

  sample(t: number, v: VehicleState, lateral: number): Packet | null {
    const yaw = this.lastHeading === null ? 0.0 : v.heading - this.lastHeading
    this.lastHeading = v.heading
    if (t - this.lastSampleT < 1.0 / SAMPLE_RATE_HZ - 1e-6) return null
    this.lastSampleT = t
    this.seq += 1
    const grip = Math.max(0.2, Math.min(1.5, this.gripEstimate))
    const wrapped = pyMod(yaw + Math.PI, 2 * Math.PI) - Math.PI
    return {
      seq: this.seq,
      sent_t: t,
      channels: { speed: [Math.max(0.0, v.speed), t], position: [v.distance_along_lap, t], grip: [grip, t] },
      lateral,
      yaw_rate: wrapped / 0.05,
    }
  }
}

// ------------------------------------------------------------------ links

/** A healthy link: no delay, loss or jitter, so items arrive the tick they're sent. */
export class Link<T> {
  private queue: T[] = []
  send(item: T): void {
    this.queue.push(item)
  }
  deliver(): T[] {
    const due = this.queue
    this.queue = []
    return due
  }
}

// ------------------------------------------------------------------ the safety system

export type DecisionState = 'brake' | 'clear' | 'stale' | 'no_data'

export interface Decision {
  seq: number
  generated_t: number
  state: DecisionState
  source: 'remote' | 'local'
  data_sample_t: number | null
  data_age_ms: number | null
  hazard_id: string | null
  hazard_label: string | null
  advised_speed: number | null
  reason: string | null
}

function decision(partial: Omit<Decision, 'hazard_id' | 'hazard_label' | 'advised_speed' | 'reason'> & Partial<Decision>): Decision {
  return { hazard_id: null, hazard_label: null, advised_speed: null, reason: null, ...partial }
}

function cornerTarget(h: HazardZone, grip: number): number {
  return h.corner_speed * Math.sqrt(Math.max(grip, 0.05))
}

/** The braking-warning rule, looking along the route: of every corner within
 *  the lookahead, the one whose braking point is most overdue.
 *  Returns [hazard, advised speed, metres ahead]. */
export function assess(distance: number, speed: number, grip: number, profile: TrackProfile): [HazardZone, number, number] | null {
  const decel = POLICY.nominal_brake_decel
  let best: [number, HazardZone, number, number] | null = null
  for (const h of profile.hazard_zones) {
    const ahead = distanceToHazard(distance, h, profile)
    if (ahead > POLICY.lookahead_m) continue
    const target = cornerTarget(h, grip)
    if (speed <= target) continue
    const required = (speed ** 2 - target ** 2) / (2 * decel) + speed * POLICY.reaction_allowance_s + POLICY.margin_m
    const slack = ahead - required
    if (slack < 0 && (best === null || slack < best[0])) best = [slack, h, target, ahead]
  }
  return best === null ? null : [best[1], best[2], best[3]]
}

/** Consumes only sensor channels. Keeps the newest sample per channel by
 *  packet sequence; an older packet can never overwrite newer data. */
export class WarningService {
  latestSeq = 0
  channels: Record<Channel, [number, number]> | null = null
  decisionSeq = 0
  private readonly profile: TrackProfile

  constructor(profile: TrackProfile) {
    this.profile = profile
  }

  receive(packet: Packet): void {
    if (packet.seq <= this.latestSeq) return
    this.latestSeq = packet.seq
    this.channels = { ...packet.channels }
  }

  dataAgeMs(t: number): number | null {
    if (!this.channels) return null
    const oldest = Math.min(...CHANNELS.map((c) => this.channels![c][1])) // per-channel freshness
    return (t - oldest) * 1000
  }

  decide(t: number): Decision {
    this.decisionSeq += 1
    const age = this.dataAgeMs(t)
    const base = { seq: this.decisionSeq, generated_t: t, source: 'remote' as const }
    if (age === null || !this.channels) {
      return decision({ ...base, state: 'no_data', data_sample_t: null, data_age_ms: null, reason: 'No telemetry received' })
    }
    const oldest = t - age / 1000
    if (age > POLICY.stale_threshold_ms) {
      const stale = CHANNELS.filter((c) => (t - this.channels![c][1]) * 1000 > POLICY.stale_threshold_ms)
      return decision({
        ...base,
        state: 'stale',
        data_sample_t: oldest,
        data_age_ms: age,
        reason: `Telemetry stale (${stale.join(', ')} ${pyFormat0(age)} ms old)`,
      })
    }
    const found = assess(this.channels.position[0], this.channels.speed[0], this.channels.grip[0], this.profile)
    if (found === null) return decision({ ...base, state: 'clear', data_sample_t: oldest, data_age_ms: age })
    const [h, target, ahead] = found
    return decision({
      ...base,
      state: 'brake',
      data_sample_t: oldest,
      data_age_ms: age,
      hazard_id: h.id,
      hazard_label: h.label,
      advised_speed: target,
      reason: `Brake for ${h.label} in ${pyFormat0(ahead)} m`,
    })
  }
}

/** What the driver sees: remote decisions as they arrive over the downlink. */
export class DriverDisplay {
  remote: Decision | null = null
  shown: Decision | null = null

  receiveRemote(d: Decision): void {
    if (this.remote !== null && d.seq <= this.remote.seq) return // late/out-of-order: never overrides a newer one
    this.remote = d
  }

  remoteAgeMs(t: number): number | null {
    if (this.remote === null || this.remote.data_sample_t === null) return null
    return (t - this.remote.data_sample_t) * 1000
  }

  resolve(t: number): Decision | null {
    const age = this.remoteAgeMs(t)
    if (this.remote !== null) {
      // A late BRAKE is still shown (late beats never); an old "all clear" is
      // not trusted and becomes a STALE caution.
      if (this.remote.state === 'clear' && age !== null && age > POLICY.stale_threshold_ms) {
        this.shown = decision({
          seq: this.remote.seq,
          generated_t: t,
          state: 'stale',
          source: 'remote',
          data_sample_t: this.remote.data_sample_t,
          data_age_ms: age,
          reason: `No fresh warning data (${pyFormat0(age)} ms)`,
        })
      } else {
        this.shown = this.remote
      }
    }
    return this.shown
  }
}
