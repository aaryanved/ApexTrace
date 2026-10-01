// Simplified 2026-regulation F1 car dynamics: a planar "bicycle" model (one
// front and one rear axle) with Pacejka-style tyres, a friction circle,
// speed-dependent aero with 2026 active aero (Z-mode / X-mode "DRS"), load
// transfer, a 400 kW ICE + 350 kW MGU-K power unit on a 4 MJ battery, an
// 8-speed gearbox, driver aids (TC, ABS, stability control) and reverse.
//
// Ported line for line from the Python model this project started with
// (backend/app/f1_car.py, see git history) and tested against steps it
// recorded (src/sim/__fixtures__). Numbers follow public 2026 figures; a
// plausible approximation for a simulator, not team data.

import { clamp, copysign, pyRound } from './pyMath'

export const G = 9.81
export const RHO = 1.225

export type TractionControl = 'off' | 'medium' | 'full'
export type Gearbox = 'automatic' | 'manual'
export type DrsMode = 'off' | 'auto' | 'manual'
export type ErsMode = 'harvest' | 'balanced' | 'overtake'

const deg = (d: number) => (d * Math.PI) / 180

export const CAR = {
  mass: 800.0, // 768 kg minimum (car + driver) plus fuel
  yaw_inertia: 1050.0,
  wheelbase: 3.4,
  cg_to_front: 1.82, // ~46.5 % static weight on the front
  cg_height: 0.3,
  frontal_area: 1.5,
  // Z-mode (wings closed, cornering) and X-mode (wings open, straights)
  cl_z: 2.5,
  cd_z: 0.75,
  cl_x: 1.5,
  cd_x: 0.52,
  aero_balance_front: 0.44,
  // tyres
  mu_lat: 1.6,
  mu_long: 1.85, // slicks give more longitudinal than lateral grip
  tyre_b: 15.4, // with tyre_c this puts peak lateral force near 7 degrees of slip
  tyre_c: 1.45,
  sliding_mu_ratio: 0.8, // grip of a locked or spinning tyre
  // Tyre load sensitivity: mu(f) = mu0 * (1 - k (f / f_ref - 1)), per tyre.
  load_sensitivity: 0.1,
  tyre_ref_load: 3700.0, // N per tyre: about the load at 200 km/h
  track_width: 1.6, // m, for lateral load transfer between inner and outer tyres
  rolling_resistance: 0.015,
  // brakes (brake-by-wire)
  brake_force_max: 33_000.0, // ~4.2 g of brake-system force
  brake_bias_front: 0.56,
  // power unit
  ice_power: 400_000.0,
  mguk_power: 350_000.0,
  driveline_efficiency: 0.92,
  mguk_full_until: 290 / 3.6,
  mguk_full_until_overtake: 337 / 3.6,
  mguk_zero_at: 355 / 3.6,
  battery_capacity: 4.0e6, // J usable
  regen_power: 350_000.0,
  coast_harvest_power: 120_000.0,
  harvest_mode_power: 100_000.0, // recharge taken from the ICE at full throttle in Harvest mode
  max_tractive_force: 20_000.0, // torque limit at very low speed
  // gearbox: road speed in each gear at the shift rpm
  gear_speeds_kmh: [95, 135, 170, 205, 240, 275, 310, 350],
  shift_rpm: 12_000.0,
  rev_limit: 12_500.0,
  idle_rpm: 4_000.0,
  downshift_rpm: 7_000.0,
  // steering
  max_road_wheel_angle: 0.38, // rad (~22 deg) at low speed
  // reverse
  reverse_force: 6_000.0, // N at full throttle
  reverse_max_speed: 22 / 3.6,
  reverse_hold_s: 0.8, // automatic: brake held this long at standstill selects reverse
  reverse_engage_speed: 1.5, // m/s: gear change to/from R only below this
  steer_slip_allowance: 0.12, // rad beyond the steady-state angle at full lock
  // stability control (part of the traction-control modes)
  esc_slip_full: deg(2.5),
  esc_slip_medium: deg(6.0),
  esc_yaw_full: 5.0, // max corrective yaw acceleration, rad/s^2
  esc_yaw_medium: 2.5,
  cg_to_rear: 3.4 - 1.82,
  gears: 8,
} as const

export type CarParams = typeof CAR

export interface CarSetup {
  traction_control: TractionControl
  abs: boolean // real F1 cars have none; off means overbraking locks the wheels
  gearbox: Gearbox
  drs_mode: DrsMode
  ers_mode: ErsMode
}

export const DEFAULT_SETUP: CarSetup = {
  traction_control: 'full',
  abs: true,
  gearbox: 'automatic',
  drs_mode: 'auto',
  ers_mode: 'balanced',
}

/** Discrete requests since the last tick (manual gearbox / active aero). */
export interface DriverRequests {
  shift_up: number
  shift_down: number
  drs_toggle: number
  reverse_toggle: number // engage/leave reverse (only when nearly stopped)
}

export const NO_REQUESTS: DriverRequests = { shift_up: 0, shift_down: 0, drs_toggle: 0, reverse_toggle: 0 }

export interface CarState {
  vx: number // forward speed, body frame (m/s)
  vy: number // lateral speed, body frame, + = left
  yaw_rate: number // rad/s, + = left
  gear: number // 0 = not yet selected (picked from speed on the first step); -1 = reverse
  rpm: number
  battery: number // J
  drs_open: boolean
  ax: number // body-frame accelerations of the last substep (m/s^2)
  ay: number
  tc_cut: number // fraction of requested drive removed by traction control
  stop_hold: number // s stationary with the brake held and no throttle (automatic: engages reverse)
  brake_reverse: boolean // reverse engaged by holding the brake: brake pedal drives, throttle stops
  wheelspin: boolean
  front_lock: boolean
  rear_lock: boolean
  ers_deploy_kw: number // + deploying, - harvesting
  drs_available: boolean
}

export const INITIAL_CAR_STATE: CarState = {
  vx: 0,
  vy: 0,
  yaw_rate: 0,
  gear: 0,
  rpm: 4_000.0,
  battery: 4.0e6,
  drs_open: false,
  ax: 0,
  ay: 0,
  tc_cut: 0,
  stop_hold: 0,
  brake_reverse: false,
  wheelspin: false,
  front_lock: false,
  rear_lock: false,
  ers_deploy_kw: 0,
  drs_available: false,
}

// ------------------------------------------------------------------ helpers

/** (ClA, CdA) in m^2 for the current active-aero mode. */
export function aeroCoefficients(drsOpen: boolean, p: CarParams = CAR): [number, number] {
  const [cl, cd] = drsOpen ? [p.cl_x, p.cd_x] : [p.cl_z, p.cd_z]
  return [cl * p.frontal_area, cd * p.frontal_area]
}

/** Peak force (N) one axle's two tyres can make: each tyre carries half the
 *  axle load, +/- the lateral load transfer, with load-sensitive friction. */
export function axleGrip(axleLoad: number, mu: number, transfer = 0.0, p: CarParams = CAR): number {
  let total = 0.0
  for (let f of [axleLoad / 2 + transfer, axleLoad / 2 - transfer]) {
    f = Math.max(0.0, f)
    total += f * mu * Math.max(0.55, 1.0 - p.load_sensitivity * (f / p.tyre_ref_load - 1.0))
  }
  return total
}

function axleLoads(speed: number, drsOpen: boolean, p: CarParams): [number, number] {
  const [cla] = aeroCoefficients(drsOpen, p)
  const downforce = 0.5 * RHO * cla * speed * speed
  const a = p.cg_to_front
  const b = p.cg_to_rear
  const L = p.wheelbase
  return [p.mass * G * b / L + downforce * p.aero_balance_front, p.mass * G * a / L + downforce * (1 - p.aero_balance_front)]
}

// Python cached this on a rounded grid (lru_cache); the rounding is part of
// the model's behaviour, so it is kept, and the cache with it.
const lateralCache = new Map<string, number>()

/** Steady cornering limit in m/s^2 at this speed: weight + downforce, with
 *  load-sensitive tyres and the load transfer the cornering itself causes. */
export function maxLateralAccel(speed: number, grip = 1.0, drsOpen = false): number {
  const s = pyRound(speed, 1)
  const g = pyRound(grip, 3)
  const key = `${s}|${g}|${drsOpen ? 1 : 0}`
  let value = lateralCache.get(key)
  if (value === undefined) {
    if (lateralCache.size >= 65536) lateralCache.clear()
    value = maxLateral(s, g, drsOpen, CAR)
    lateralCache.set(key, value)
  }
  return value
}

function maxLateral(speed: number, grip: number, drsOpen: boolean, p: CarParams): number {
  const [fzF, fzR] = axleLoads(speed, drsOpen, p)
  const total = fzF + fzR
  let acc = (grip * p.mu_lat * total) / p.mass
  for (let i = 0; i < 6; i++) {
    // fixed point: transfer depends on the acceleration it limits
    const moved = (p.mass * acc * p.cg_height) / p.track_width
    acc = (grip * (axleGrip(fzF, p.mu_lat, (moved * fzF) / total, p) + axleGrip(fzR, p.mu_lat, (moved * fzR) / total, p))) / p.mass
  }
  return acc
}

function mgukTaper(speed: number, mode: ErsMode, p: CarParams): number {
  if (mode === 'harvest') return 0.0
  const full = mode === 'overtake' ? p.mguk_full_until_overtake : p.mguk_full_until
  if (speed <= full) return 1.0
  if (speed >= p.mguk_zero_at) return 0.0
  return (p.mguk_zero_at - speed) / (p.mguk_zero_at - full)
}

/** Speed where full-power drive equals drag (balanced ERS, full battery). */
export function topSpeedEstimate(drsOpen = false, p: CarParams = CAR): number {
  let lo = 10.0
  let hi = 120.0
  for (let i = 0; i < 60; i++) {
    const v = (lo + hi) / 2
    const power = (p.ice_power + p.mguk_power * mgukTaper(v, 'balanced', p)) * p.driveline_efficiency
    const [, cda] = aeroCoefficients(drsOpen, p)
    const drag = 0.5 * RHO * cda * v * v + p.rolling_resistance * p.mass * G
    if (power / v > drag) lo = v
    else hi = v
  }
  return lo
}

/** Speed-sensitive steering range: full lock at low speed; at speed, full
 *  input asks for a little more than the grip limit. */
export function maxSteerAngle(speed: number, p: CarParams = CAR, drsOpen = false): number {
  if (speed < 8.0) return p.max_road_wheel_angle
  const aLat = maxLateralAccel(speed, 1.0, drsOpen)
  const steady = Math.atan((p.wheelbase * aLat) / (speed * speed))
  return Math.min(p.max_road_wheel_angle, steady + p.steer_slip_allowance)
}

/** Lowest gear that keeps the engine under the shift rpm. */
export function gearForSpeed(speed: number, p: CarParams = CAR): number {
  for (let g = 1; g <= p.gear_speeds_kmh.length; g++) {
    if (speed * 3.6 <= p.gear_speeds_kmh[g - 1] * 0.98) return g
  }
  return p.gears
}

export function engineRpm(speed: number, gear: number, p: CarParams = CAR): number {
  // Python indexes gear_speeds_kmh[gear - 1]; gear is never 0 or -1 here
  const top = p.gear_speeds_kmh[gear - 1] / 3.6
  return Math.max(p.idle_rpm, (speed / top) * p.shift_rpm)
}

/** Simplified power curve: builds from idle, flat near the top, cut at the limiter. */
function icePowerFraction(rpm: number, p: CarParams): number {
  if (rpm >= p.rev_limit) return 0.0
  if (rpm <= 6_000) return 0.35 + (0.25 * (rpm - p.idle_rpm)) / (6_000 - p.idle_rpm)
  if (rpm <= 10_500) return 0.6 + (0.4 * (rpm - 6_000)) / 4_500
  return 1.0
}

/** Pacejka-style lateral force (opposes slip). */
function tyreLateral(slip: number, peakForce: number, p: CarParams): number {
  return -peakForce * Math.sin(p.tyre_c * Math.atan(p.tyre_b * slip))
}

// ------------------------------------------------------------------ gearbox & aero control

export const REVERSE = -1

function updateGear(state: CarState, setup: CarSetup, requests: DriverRequests, throttle: number, brake: number, p: CarParams): number {
  const speed = Math.max(state.vx, 0.0)
  let gear = state.gear || gearForSpeed(speed, p)
  const slow = Math.abs(state.vx) < p.reverse_engage_speed
  if (requests.reverse_toggle % 2 === 1 && slow) return gear === REVERSE ? 1 : REVERSE
  if (gear === REVERSE) {
    // manual: shifting up from R selects 1st once stopped
    return setup.gearbox === 'manual' && requests.shift_up > 0 && slow ? 1 : REVERSE
  }
  if (setup.gearbox === 'manual') {
    if (gear === 1 && requests.shift_down > 0 && requests.shift_up === 0 && slow) return REVERSE
    gear = Math.min(p.gears, gear + requests.shift_up)
    for (let i = 0; i < requests.shift_down; i++) {
      // over-rev protection: refuse a downshift that would pass the limiter
      if (gear > 1 && engineRpm(speed, gear - 1, p) <= p.rev_limit) gear -= 1
    }
    return gear
  }
  const rpm = engineRpm(speed, gear, p)
  if (rpm >= p.shift_rpm && gear < p.gears && throttle > 0.05) gear += 1
  const downAt = brake > 0.1 ? 8_500.0 : p.downshift_rpm
  while (gear > 1 && engineRpm(speed, gear, p) < downAt && engineRpm(speed, gear - 1, p) < p.shift_rpm * 0.97) gear -= 1
  return gear
}

/** (open, available). X-mode may only be open on a straight; braking always closes it. */
function updateDrs(
  state: CarState,
  setup: CarSetup,
  requests: DriverRequests,
  allowed: boolean,
  throttle: number,
  brake: number,
  steering: number,
): [boolean, boolean] {
  const available = allowed && setup.drs_mode !== 'off'
  if (!available || brake > 0.05) return [false, available]
  if (setup.drs_mode === 'auto') return [throttle > 0.9 && Math.abs(steering) < 0.15, available]
  let opened = state.drs_open
  if (requests.drs_toggle % 2 === 1) opened = !opened
  return [opened, available]
}

// ------------------------------------------------------------------ integration

export type StepResult = [CarState, number, number, number] // state, heading, dx, dy

/** Reversing is always slow, so a kinematic model is enough. When reverse was
 *  engaged by holding the brake at standstill the pedals swap. */
function stepReverse(
  s: CarState,
  heading: number,
  steering: number,
  throttle: number,
  brake: number,
  dt: number,
  grip: number,
  brakeScale: number,
  p: CarParams,
): StepResult {
  if (s.brake_reverse) [throttle, brake] = [brake, throttle]
  const vx = s.vx
  const drive = throttle * p.reverse_force * (-vx < p.reverse_max_speed ? 1.0 : 0.0)
  const stop = brake * Math.min(p.brake_force_max * brakeScale, grip * p.mu_long * p.mass * G) + 300.0
  const force = -drive + (vx < 0 ? stop : vx > 0 ? -stop : 0.0)
  const ax = force / p.mass
  let vxNew = vx + ax * dt
  if ((vx < 0 && 0 <= vxNew && drive === 0) || (vx > 0 && 0 >= vxNew)) {
    vxNew = 0.0 // brakes/rolling resistance stop the car, they don't reverse its direction
  }
  vxNew = Math.max(-p.reverse_max_speed, vxNew)
  const delta = steering * p.max_road_wheel_angle
  const r = (vxNew * Math.tan(delta)) / p.wheelbase
  const mid = heading + (r * dt) / 2
  const dx = vxNew * Math.cos(mid) * dt
  const dy = vxNew * Math.sin(mid) * dt
  return [
    {
      ...s,
      vx: vxNew,
      vy: 0.0,
      yaw_rate: r,
      rpm: p.idle_rpm + 4_000 * throttle,
      ax,
      ay: vxNew * r,
      tc_cut: 0.0,
      wheelspin: false,
      front_lock: false,
      rear_lock: false,
      ers_deploy_kw: 0.0,
    },
    heading + r * dt,
    dx,
    dy,
  ]
}

export const SUBSTEP = 0.004 // s; tyre forces are stiff, so integrate finer than the 20 Hz tick

export interface StepOptions {
  grip?: number
  brakeScale?: number
  powerScale?: number
  setup?: CarSetup
  requests?: DriverRequests
  drsAllowed?: boolean
  offroadDrag?: number
}

/** Advance the car by dt. Returns [new state, new heading, dx, dy] in world frame.
 *  `grip` scales tyre friction, `brakeScale` the brake system (wear/fade),
 *  `powerScale` the drive (off-road), `offroadDrag` adds a resistance force in N. */
export function stepCar(
  state: CarState,
  heading: number,
  steering: number,
  throttle: number,
  brake: number,
  dt: number,
  {
    grip = 1.0,
    brakeScale = 1.0,
    powerScale = 1.0,
    setup = DEFAULT_SETUP,
    requests = NO_REQUESTS,
    drsAllowed = false,
    offroadDrag = 0.0,
  }: StepOptions = {},
  p: CarParams = CAR,
): StepResult {
  steering = clamp(steering, -1.0, 1.0)
  throttle = clamp(throttle, 0.0, 1.0)
  brake = clamp(brake, 0.0, 1.0)

  let gear = updateGear(state, setup, requests, throttle, brake, p)
  const automatic = setup.gearbox === 'automatic'
  let stopHold = state.stop_hold
  let brakeReverse = state.brake_reverse
  if (automatic && state.gear !== REVERSE && Math.abs(state.vx) < 0.3 && brake > 0.5 && throttle < 0.05) stopHold += dt
  else stopHold = 0.0
  if (automatic && gear !== REVERSE && stopHold >= p.reverse_hold_s) {
    gear = REVERSE // stopped and still on the brakes: select R
    brakeReverse = true
    stopHold = 0.0
  } else if (gear === REVERSE && brakeReverse && throttle > 0.3 && brake < 0.05 && Math.abs(state.vx) < 0.5) {
    gear = 1 // throttle from standstill: back to drive
    brakeReverse = false
  }
  if (gear !== REVERSE) brakeReverse = false
  if (gear === REVERSE) {
    return stepReverse(
      { ...state, gear, drs_open: false, drs_available: false, stop_hold: stopHold, brake_reverse: brakeReverse },
      heading,
      steering,
      throttle,
      brake,
      dt,
      grip,
      brakeScale,
      p,
    )
  }
  const [drsOpen, drsAvailable] = updateDrs(state, setup, requests, drsAllowed, throttle, brake, steering)
  let s: CarState = { ...state, gear, drs_open: drsOpen, drs_available: drsAvailable, stop_hold: stopHold, brake_reverse: brakeReverse }

  const n = Math.max(1, Math.ceil(dt / SUBSTEP))
  const h = dt / n
  let dx = 0.0
  let dy = 0.0
  const a = p.cg_to_front
  const b = p.cg_to_rear
  const L = p.wheelbase
  const m = p.mass
  const [cla, cda] = aeroCoefficients(drsOpen, p)
  const escThr = setup.traction_control === 'full' ? p.esc_slip_full : setup.traction_control === 'medium' ? p.esc_slip_medium : null
  const escGain = setup.traction_control === 'full' ? p.esc_yaw_full : setup.traction_control === 'medium' ? p.esc_yaw_medium : 0.0
  for (let k = 0; k < n; k++) {
    const vx = s.vx
    const vy = s.vy
    const r = s.yaw_rate
    const speed = Math.hypot(vx, vy)
    const q = 0.5 * RHO * speed * speed
    const downforce = q * cla
    const drag = q * cda + p.rolling_resistance * m * G + offroadDrag * (speed > 0.1 ? 1 : 0)

    // axle loads: static + aero + longitudinal load transfer
    const transfer = (m * s.ax * p.cg_height) / L
    const fzF = Math.max(0.0, (m * G * b) / L + downforce * p.aero_balance_front - transfer)
    const fzR = Math.max(0.0, (m * G * a) / L + downforce * (1 - p.aero_balance_front) + transfer)
    // lateral load transfer (outer tyres loaded, inner unloaded), split by axle load
    const moved = (m * Math.abs(s.ay) * p.cg_height) / p.track_width
    const shareF = fzF / Math.max(fzF + fzR, 1e-6)
    const dtF = moved * shareF
    const dtR = moved * (1 - shareF)
    const capFLat = grip * axleGrip(fzF, p.mu_lat, dtF, p)
    const capRLat = grip * axleGrip(fzR, p.mu_lat, dtR, p)
    const capFLong = grip * axleGrip(fzF, p.mu_long, dtF, p)
    const capRLong = grip * axleGrip(fzR, p.mu_long, dtR, p)

    // --- power unit ------------------------------------------------------
    const rpm = engineRpm(Math.max(vx, 0.0), gear, p)
    let ice = p.ice_power * icePowerFraction(rpm, p) * throttle
    const taper = mgukTaper(Math.max(vx, 0.0), setup.ers_mode, p)
    const mguk = s.battery > 0 && rpm < p.rev_limit ? p.mguk_power * taper * throttle : 0.0
    let battery = s.battery
    let harvest = 0.0
    if (setup.ers_mode === 'harvest' && throttle > 0.8) {
      harvest = Math.min(p.harvest_mode_power, ice)
      ice -= harvest
    }
    const drivePower = (ice + mguk) * p.driveline_efficiency * powerScale
    const driveRequest = vx >= 0 ? Math.min(p.max_tractive_force, drivePower / Math.max(vx, 1.5)) : 0.0

    // --- brakes -------------------------------------------------------------
    const brakeTotal = brake * p.brake_force_max
    let brakeF = brakeTotal * p.brake_bias_front
    let brakeR = brakeTotal * (1 - p.brake_bias_front)
    // stability control: rear slip angle of the previous substep (needs vx > 0)
    const rearSlipPrev = Math.atan2(vy - b * r, Math.max(vx, 3.0))
    const escExcess = escThr !== null && vx > 3.0 ? Math.max(0.0, Math.abs(rearSlipPrev) - escThr) : 0.0
    if (escExcess > 0) {
      // rear stepping out: shed rear braking, the front does the work
      const shift = Math.min(1.0, escExcess / 0.08)
      ;[brakeF, brakeR] = [brakeF + brakeR * shift, brakeR * (1 - shift)]
    }

    // longitudinal capacity left after cornering load (friction circle)
    const fyFPrev = (Math.abs(s.ay) * m * b) / L
    const fyRPrev = (Math.abs(s.ay) * m * a) / L
    let roomF = Math.sqrt(Math.max(0.0, capFLong ** 2 - Math.min(fyFPrev, capFLat) ** 2 * (capFLong / Math.max(capFLat, 1e-6)) ** 2))
    let roomR = Math.sqrt(Math.max(0.0, capRLong ** 2 - Math.min(fyRPrev, capRLat) ** 2 * (capRLong / Math.max(capRLat, 1e-6)) ** 2))
    roomF = Math.max(roomF, 0.3 * capFLong)
    roomR = Math.max(roomR, 0.3 * capRLong)

    if (setup.abs) {
      // hold each axle just under its locking point
      ;[brakeF, brakeR] = [Math.min(brakeF, 0.97 * roomF), Math.min(brakeR, 0.97 * roomR)]
      // Keep the car steerable: reserve the lateral grip the current steering
      // asks for, so full brake + full lock trail-brakes into the corner
      // instead of ploughing straight on. At least 35% of braking remains.
      const deltaPre = steering * maxSteerAngle(Math.max(vx, 0.0), p, s.drs_open)
      const vxPre = Math.max(vx, 1.0)
      const wantF = Math.abs(tyreLateral(Math.atan2(vy + a * r, vxPre) - deltaPre, capFLat, p)) / Math.max(capFLat, 1e-6)
      const wantR = Math.abs(tyreLateral(Math.atan2(vy - b * r, vxPre), capRLat, p)) / Math.max(capRLat, 1e-6)
      const keepF = Math.max(0.35, Math.sqrt(Math.max(0.0, 1.0 - Math.min(1.0, wantF) ** 2)))
      const keepR = Math.max(0.35, Math.sqrt(Math.max(0.0, 1.0 - Math.min(1.0, wantR) ** 2)))
      ;[brakeF, brakeR] = [Math.min(brakeF, 0.97 * keepF * capFLong), Math.min(brakeR, 0.97 * keepR * capRLong)]
    }
    brakeF *= brakeScale
    brakeR *= brakeScale
    const frontLock = brakeF > roomF && vx > 2.0
    const fxF = -(frontLock ? p.sliding_mu_ratio * capFLong : brakeF)

    // rear axle: drive minus braking, with traction control / wheelspin / lockup
    let tcCut = 0.0
    let wheelspin = false
    const rearBrake = brakeR <= roomR ? Math.min(brakeR, roomR) : p.sliding_mu_ratio * capRLong
    const rearLock = brakeR > roomR && vx > 2.0
    let drive = brake < 0.05 ? driveRequest : 0.0
    let allowed: number
    if (setup.traction_control === 'full') {
      // straight-line launch may use 90% of the rear's room; cornering load
      // shrinks that to 65% so the rear keeps lateral grip to hold the car
      allowed = (0.9 - 0.25 * Math.min(1.0, fyRPrev / Math.max(capRLat, 1e-6))) * roomR
    } else if (setup.traction_control === 'medium') {
      allowed = 0.98 * roomR // a big lateral load can still break it loose
    } else {
      allowed = Infinity
    }
    if (escExcess > 0 && escGain > 0) {
      allowed = Math.min(allowed, driveRequest * Math.max(0.0, 1.0 - escExcess / 0.06)) // lift when the rear steps out
    }
    if (drive > allowed) {
      tcCut = 1.0 - allowed / drive
      drive = allowed
    }
    if (drive > roomR) {
      wheelspin = true
      drive = p.sliding_mu_ratio * capRLong
    }
    let fxR = drive - rearBrake

    // engine braking + coast harvesting when off the throttle
    if (throttle < 0.05 && brake < 0.05 && vx > 5.0) {
      const coast = Math.min(p.coast_harvest_power / vx, 0.3 * m * G)
      fxR -= coast
      harvest += p.coast_harvest_power
    }
    const regen = brake > 0.05 ? Math.min(p.regen_power, brakeR * Math.max(vx, 0.0)) : 0.0
    harvest += regen
    battery = Math.min(p.battery_capacity, Math.max(0.0, battery - mguk * h + harvest * h))

    // --- lateral tyre forces -------------------------------------------
    const delta = steering * maxSteerAngle(Math.max(vx, 0.0), p, drsOpen)
    const vxSlip = Math.max(vx, 1.0)
    const slipF = Math.atan2(vy + a * r, vxSlip) - delta
    const slipR = Math.atan2(vy - b * r, vxSlip)
    let latF = Math.sqrt(Math.max(0.0, capFLat ** 2 - ((fxF * capFLat) / Math.max(capFLong, 1e-6)) ** 2))
    let latR = Math.sqrt(Math.max(0.0, capRLat ** 2 - ((fxR * capRLat) / Math.max(capRLong, 1e-6)) ** 2))
    if (frontLock) latF *= 0.3
    if (rearLock) latR *= 0.3
    if (wheelspin) latR *= 0.35
    const fyF = tyreLateral(slipF, latF, p)
    const fyR = tyreLateral(slipR, latR, p)

    // --- equations of motion (body frame) ------------------------------
    const cosD = Math.cos(delta)
    const sinD = Math.sin(delta)
    const fx = fxF * cosD - fyF * sinD + fxR - drag * (vx > 0 ? 1 : 0)
    const fy = fxF * sinD + fyF * cosD + fyR
    const ax = fx / m
    const ay = fy / m
    let yawAcc = (a * (fyF * cosD + fxF * sinD) - b * fyR) / p.yaw_inertia
    if (escExcess > 0 && escGain > 0 && r * rearSlipPrev < 0) {
      // oversteer: rotating the way the rear slides
      yawAcc += copysign(Math.min(escGain, (escGain * escExcess) / 0.06), rearSlipPrev)
    }

    let vxNew = vx + (ax + vy * r) * h
    let vyNew = vy + (ay - vx * r) * h
    let rNew = r + yawAcc * h
    if (vxNew < 0.0) {
      // brakes and drag don't drive the car backwards
      vxNew = 0.0
      vyNew = 0.0
      rNew = 0.0
    }

    // low speed: tyre slip models break down, blend to kinematic steering
    const w = Math.min(1.0, Math.max(0.0, (vxNew - 3.0) / 4.0))
    if (w < 1.0) {
      const rKin = (vxNew * Math.tan(delta)) / L
      rNew = w * rNew + (1 - w) * rKin
      vyNew = w * vyNew + (1 - w) * rKin * b
    }

    const midHeading = heading + (rNew * h) / 2
    dx += (vxNew * Math.cos(midHeading) - vyNew * Math.sin(midHeading)) * h
    dy += (vxNew * Math.sin(midHeading) + vyNew * Math.cos(midHeading)) * h
    heading += rNew * h

    s = {
      ...s,
      vx: vxNew,
      vy: vyNew,
      yaw_rate: rNew,
      rpm: Math.min(engineRpm(Math.max(vxNew, 0.0), gear, p), p.rev_limit),
      battery,
      ax,
      ay: fy / m,
      tc_cut: tcCut,
      wheelspin,
      front_lock: frontLock,
      rear_lock: rearLock,
      ers_deploy_kw: (mguk - harvest) / 1000.0,
    }
  }
  return [s, heading, dx, dy]
}
