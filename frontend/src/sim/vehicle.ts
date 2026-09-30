// The car on the track: position, lap progress, track limits, surfaces and
// barriers around the car model in car.ts. Ported from the Python simulator
// (backend/app/placeholder_sim.py, see git history).

import type { HazardZone, Sector, TrackProfile } from '../types/schemas'
import { constrainMotion } from './barriers'
import { CAR, DEFAULT_SETUP, NO_REQUESTS, stepCar, topSpeedEstimate, type CarSetup, type CarState, type DriverRequests } from './car'
import { pyMod } from './pyMath'

export const MAX_SPEED = topSpeedEstimate(true) // ~343 km/h in X-mode
// Representative full-braking deceleration (~3.3 g averaged over a stop).
export const BRAKE_DECEL = 32.0
// Off the track (grass): less grip and power, heavy drag above a crawl.
const RUNOFF_MAX_SPEED = 22.0
const RUNOFF_DECEL = 18.0
// What is beside the edge line, matching what the Drive screen draws: kerbs
// 1.4 m wide at corners (within 20 m of a hazard zone), then paved runoff
// (Monza: 4 m of asphalt; Baku: paving right up to the wall), then grass.
const KERB_WIDTH_M = 1.4
const KERB_PAD_M = 20.0
const PAVED_RUNOFF_M: Record<string, number> = { monza: 4.0 } // tracks not listed are paved to the barrier
export type Surface = 'track' | 'kerb' | 'runoff' | 'grass'
// (grip, power) multipliers per surface; grass also gets RUNOFF drag.
const SURFACE_GRIP: Record<Surface, [number, number]> = { track: [1.0, 1.0], kerb: [0.93, 1.0], runoff: [0.8, 0.9], grass: [0.5, 0.35] }
export const CAR_HALF_WIDTH = 0.95 // 2026 car: 1.9 m wide

export interface VehicleState {
  x: number
  y: number
  heading: number
  speed: number
  seq: number
  nearest_point_index: number
  distance_along_lap: number
  off_track: boolean // outside the track edges right now
  track_exit: boolean // has left the track at least once this run
  track_exits: number
  laps_completed: number
  lap_complete: boolean // at least one full lap done
  lap_time: number
  last_lap_time: number | null
  best_lap_time: number | null
  lap_clean: boolean // current lap within track limits
  last_lap_valid: boolean | null
  barrier_contacts: number
  in_contact: boolean
  // vehicle dynamics (car.ts)
  vy: number
  yaw_rate: number
  gear: number
  rpm: number
  battery: number
  drs_open: boolean
  drs_available: boolean
  tc_cut: number
  wheelspin: boolean
  front_lock: boolean
  rear_lock: boolean
  ax: number
  ay: number
  ers_deploy_kw: number
  stop_hold: number
  brake_reverse: boolean
}

const VEHICLE_DEFAULTS: VehicleState = {
  x: 0,
  y: 0,
  heading: 0,
  speed: 0,
  seq: 0,
  nearest_point_index: 0,
  distance_along_lap: 0,
  off_track: false,
  track_exit: false,
  track_exits: 0,
  laps_completed: 0,
  lap_complete: false,
  lap_time: 0,
  last_lap_time: null,
  best_lap_time: null,
  lap_clean: true,
  last_lap_valid: null,
  barrier_contacts: 0,
  in_contact: false,
  vy: 0,
  yaw_rate: 0,
  gear: 0,
  rpm: 4_000.0,
  battery: CAR.battery_capacity,
  drs_open: false,
  drs_available: false,
  tc_cut: 0,
  wheelspin: false,
  front_lock: false,
  rear_lock: false,
  ax: 0,
  ay: 0,
  ers_deploy_kw: 0,
  stop_hold: 0,
  brake_reverse: false,
}

function carState(v: VehicleState): CarState {
  return {
    vx: v.speed,
    vy: v.vy,
    yaw_rate: v.yaw_rate,
    gear: v.gear,
    rpm: v.rpm,
    battery: v.battery,
    drs_open: v.drs_open,
    ax: v.ax,
    ay: v.ay,
    stop_hold: v.stop_hold,
    brake_reverse: v.brake_reverse,
    // CarState defaults for what the vehicle doesn't carry into the step
    tc_cut: 0,
    wheelspin: false,
    front_lock: false,
    rear_lock: false,
    ers_deploy_kw: 0,
    drs_available: false,
  }
}

// ------------------------------------------------------------------ track queries

/** Number of distinct points (a closed line repeats its first point). */
export function loopSize(line: readonly (readonly [number, number])[]): number {
  const closed = line.length > 1 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1]
  return closed ? line.length - 1 : line.length
}

/** Nearest sampled centerline point. With a hint (last tick's index) only a
 *  window around it is searched, and ties prefer the hint. Falls back to a
 *  full scan if the car is far away. */
export function nearestIndex(x: number, y: number, line: readonly (readonly [number, number])[], hint: number | null = null, window = 30): number {
  const n = loopSize(line)
  if (hint !== null) {
    let bestI = pyMod(hint, n)
    let bestD: number | null = null
    let bestOff = 0
    for (let offset = -window; offset <= window; offset++) {
      const i = pyMod(hint + offset, n)
      const d = Math.hypot(x - line[i][0], y - line[i][1])
      const off = Math.abs(offset)
      if (bestD === null || d < bestD || (d === bestD && off < bestOff)) {
        bestI = i
        bestD = d
        bestOff = off
      }
    }
    if (bestD !== null && bestD < 40.0) return bestI
  }
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(x - line[i][0], y - line[i][1])
    if (d < bestD) {
      best = i
      bestD = d
    }
  }
  return best
}

function distanceToSegment(px: number, py: number, a: readonly [number, number], b: readonly [number, number]): number {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const lengthSq = abx * abx + aby * aby
  if (lengthSq === 0) return Math.hypot(px - a[0], py - a[1])
  const t = Math.max(0.0, Math.min(1.0, ((px - a[0]) * abx + (py - a[1]) * aby) / lengthSq))
  return Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby))
}

/** Local half width from the drawn edges (Baku's castle section narrows to 7.6 m). */
function halfWidthAt(idx: number, profile: TrackProfile): number {
  const n = loopSize(profile.centerline)
  const [cx, cy] = profile.centerline[pyMod(idx, n)]
  const [lx, ly] = profile.left_edge[pyMod(idx, n)]
  return Math.hypot(lx - cx, ly - cy)
}

/** Local half width minus the distance to the centerline polyline (the two
 *  segments touching the nearest sample). */
function clearanceAtIndex(x: number, y: number, idx: number, profile: TrackProfile): number {
  const line = profile.centerline
  const n = loopSize(line)
  const here = line[pyMod(idx, n)]
  const distance = Math.min(distanceToSegment(x, y, line[pyMod(idx - 1, n)], here), distanceToSegment(x, y, here, line[pyMod(idx + 1, n)]))
  return halfWidthAt(idx, profile) - distance
}

/** Signed offset from the centerline at sample idx (+ = left of travel). */
export function signedLateral(x: number, y: number, idx: number, profile: TrackProfile): number {
  const line = profile.centerline
  const n = loopSize(line)
  const [cx, cy] = line[pyMod(idx, n)]
  const [lx, ly] = profile.left_edge[pyMod(idx, n)]
  const nx = lx - cx
  const ny = ly - cy
  const norm = Math.hypot(nx, ny) || 1.0
  return ((x - cx) * nx + (y - cy) * ny) / norm
}

/** Distance from (x, y) to the track edge: positive inside the corridor, negative off track. */
export function signedClearance(x: number, y: number, profile: TrackProfile, hint: number | null = null): number {
  return clearanceAtIndex(x, y, nearestIndex(x, y, profile.centerline, hint), profile)
}

export function sectorAt(distanceAlongLap: number, profile: TrackProfile): Sector {
  const d = pyMod(distanceAlongLap, profile.total_length)
  for (const sector of profile.sectors) {
    if (sector.start_distance <= d && d < sector.end_distance) return sector
  }
  return profile.sectors[profile.sectors.length - 1]
}

export function nextHazardZone(distanceAlongLap: number, profile: TrackProfile): HazardZone | null {
  if (profile.hazard_zones.length === 0) return null
  const d = pyMod(distanceAlongLap, profile.total_length)
  let best: HazardZone | null = null
  let bestAhead = Infinity
  for (const hz of profile.hazard_zones) {
    const ahead = pyMod(hz.start_distance - d, profile.total_length)
    if (ahead < bestAhead) {
      best = hz
      bestAhead = ahead
    }
  }
  return best
}

export function distanceToHazard(distanceAlongLap: number, hazard: HazardZone, profile: TrackProfile): number {
  const d = pyMod(distanceAlongLap, profile.total_length)
  return pyMod(hazard.start_distance - d, profile.total_length)
}

function startHeading(profile: TrackProfile): number {
  const [[x0, y0], [x1, y1]] = profile.centerline
  return Math.atan2(y1 - y0, x1 - x0)
}

/** Stationary on the start/finish line, pointing down the track. */
export function initialState(profile: TrackProfile): VehicleState {
  const [sx, sy] = profile.start_finish
  return { ...VEHICLE_DEFAULTS, x: sx, y: sy, heading: startHeading(profile) }
}

/** True away from every corner zone: X-mode (low-drag aero) may open here. */
function onStraight(distanceAlongLap: number, profile: TrackProfile, clearanceM = 100.0): boolean {
  const d = pyMod(distanceAlongLap, profile.total_length)
  for (const h of profile.hazard_zones) {
    if (h.start_distance - clearanceM <= d && d <= h.end_distance) return false
    if (pyMod(h.start_distance - d, profile.total_length) <= clearanceM) return false
  }
  return true
}

/** The surface under the car, from its centre's clearance to the edge line.
 *  Only used for how the car drives off the line: whether it has left the
 *  track is still decided by the edge line alone. */
export function surfaceAt(clearance: number, distanceAlongLap: number, profile: TrackProfile): Surface {
  if (clearance >= 0) return 'track'
  const depth = -clearance
  const d = pyMod(distanceAlongLap, profile.total_length)
  const atCorner = profile.hazard_zones.some((h) => h.start_distance - KERB_PAD_M <= d && d <= h.end_distance + KERB_PAD_M)
  // on the kerb while its inner wheels are (centre within half a car of the kerb's outer edge)
  if (atCorner && depth < KERB_WIDTH_M + CAR_HALF_WIDTH) return 'kerb'
  if (depth < (PAVED_RUNOFF_M[profile.id] ?? profile.barrier_offset) + CAR_HALF_WIDTH) return 'runoff'
  return 'grass'
}

// ------------------------------------------------------------------ one tick

export interface VehicleStepOptions {
  grip?: number
  brakeWear?: number
  setup?: CarSetup
  requests?: DriverRequests
}

/** One tick. Leaving the track is recorded (off_track / track_exit /
 *  track_exits) but never freezes the car: runoff slows it and the driver
 *  can rejoin. A lap is invalid once the whole car is past an edge line or
 *  touches a barrier. */
export function step(
  state: VehicleState,
  steering: number,
  throttle: number,
  brake: number,
  dt: number,
  profile: TrackProfile,
  { grip = 1.0, brakeWear = 1.0, setup = DEFAULT_SETUP, requests = NO_REQUESTS }: VehicleStepOptions = {},
): VehicleState {
  const offroad = state.off_track
  const surface: Surface = offroad
    ? surfaceAt(clearanceAtIndex(state.x, state.y, state.nearest_point_index, profile), state.distance_along_lap, profile)
    : 'track'
  const [gripScale, powerScale] = SURFACE_GRIP[surface]
  let [car, heading, dx, dy] = stepCar(carState(state), state.heading, steering, throttle, brake, dt, {
    grip: grip * gripScale,
    brakeScale: brakeWear,
    powerScale,
    offroadDrag: surface === 'grass' && state.speed > RUNOFF_MAX_SPEED ? RUNOFF_DECEL * CAR.mass : 0.0,
    setup,
    requests,
    drsAllowed: onStraight(state.distance_along_lap, profile) && state.speed > 30.0 && !offroad,
  })
  let speed = car.vx
  let x = state.x + dx
  let y = state.y + dy

  const line = profile.centerline
  const n = loopSize(line)
  const sampleStep = profile.total_length / n
  let idx = nearestIndex(x, y, line, state.nearest_point_index)

  // Sweep the complete car against the exact rendered wall polylines; stop at first contact.
  let inContact: boolean
  ;[x, y, heading, inContact] = constrainMotion(profile, state.x, state.y, state.heading, x, y, heading)
  let barrierContacts = state.barrier_contacts
  if (inContact) {
    speed = 0.0
    car = { ...car, vx: 0.0, vy: 0.0, yaw_rate: 0.0, ax: 0.0, ay: 0.0 }
    if (!state.in_contact) barrierContacts += 1
    idx = nearestIndex(x, y, line, state.nearest_point_index)
  }
  // Barriers sit outside the road edge, so contact also records an exit.
  const offTrack = clearanceAtIndex(x, y, idx, profile) < 0 || inContact

  let deltaIdx = pyMod(idx - state.nearest_point_index, n)
  if (deltaIdx > Math.floor(n / 2)) deltaIdx -= n
  // No teleporting progress across the infield: at most what the car could cover this tick.
  const maxStep = Math.ceil((speed * dt) / sampleStep) + 2
  deltaIdx = Math.max(-maxStep, Math.min(maxStep, deltaIdx))
  const distanceAlongLap = state.distance_along_lap + deltaIdx * sampleStep

  const newlyOff = offTrack && !state.off_track
  // Track limits: the lap only counts if some part of the car stays on the track.
  const beyondLimits = clearanceAtIndex(x, y, idx, profile) < -CAR_HALF_WIDTH || inContact
  let lapsCompleted = state.laps_completed
  let lapTime = state.lap_time + dt
  let lastLap = state.last_lap_time
  let bestLap = state.best_lap_time
  let lapClean = state.lap_clean
  let lastValid = state.last_lap_valid
  if (beyondLimits) lapClean = false
  if (distanceAlongLap >= (lapsCompleted + 1) * profile.total_length) {
    lapsCompleted += 1
    lastLap = lapTime
    lastValid = lapClean
    if (lapClean && (bestLap === null || lapTime < bestLap)) bestLap = lapTime
    lapTime = 0.0
    lapClean = !beyondLimits
  }

  return {
    x,
    y,
    heading,
    speed,
    seq: state.seq + 1,
    nearest_point_index: idx,
    distance_along_lap: distanceAlongLap,
    off_track: offTrack,
    track_exit: state.track_exit || offTrack,
    track_exits: state.track_exits + (newlyOff ? 1 : 0),
    laps_completed: lapsCompleted,
    lap_complete: lapsCompleted >= 1,
    lap_time: lapTime,
    last_lap_time: lastLap,
    best_lap_time: bestLap,
    lap_clean: lapClean,
    last_lap_valid: lastValid,
    barrier_contacts: barrierContacts,
    in_contact: inContact,
    vy: car.vy,
    yaw_rate: car.yaw_rate,
    gear: car.gear,
    rpm: car.rpm,
    battery: car.battery,
    drs_open: car.drs_open,
    drs_available: car.drs_available,
    tc_cut: car.tc_cut,
    wheelspin: car.wheelspin,
    front_lock: car.front_lock,
    rear_lock: car.rear_lock,
    ax: car.ax,
    ay: car.ay,
    ers_deploy_kw: car.ers_deploy_kw,
    stop_hold: car.stop_hold,
    brake_reverse: car.brake_reverse,
  }
}
