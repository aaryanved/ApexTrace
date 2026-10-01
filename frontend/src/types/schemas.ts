// Tracks, car setup and the messages the simulator session (src/sim/session.ts)
// produces for the Drive screen.

export type TrackId = 'monza' | 'baku'
export type HazardKind = 'braking_zone' | 'chicane' | 'sweeper' | 'narrow'

export interface Sector {
  index: number
  name: string
  start_distance: number
  end_distance: number
  start_position: [number, number]
}

export interface HazardZone {
  id: string
  kind: HazardKind
  label: string
  start_distance: number
  end_distance: number
  position: [number, number]
  corner_speed: number
}

export interface TrackProfile {
  id: TrackId
  name: string
  seed: number
  track_width: number
  total_length: number
  barrier_offset: number
  start_finish: [number, number]
  centerline: [number, number][]
  left_edge: [number, number][]
  right_edge: [number, number][]
  sectors: Sector[]
  hazard_zones: HazardZone[]
}

// Driver assists and modes of the 2026 car (src/sim/car.ts).
export type TractionControl = 'off' | 'medium' | 'full'
export type Gearbox = 'automatic' | 'manual'
export type DrsMode = 'off' | 'auto' | 'manual'
export type ErsMode = 'harvest' | 'balanced' | 'overtake'

export interface CarSetupConfig {
  traction_control: TractionControl
  abs: boolean
  gearbox: Gearbox
  drs_mode: DrsMode
  ers_mode: ErsMode
}

export const DEFAULT_CAR_SETUP: CarSetupConfig = {
  traction_control: 'full',
  abs: true,
  gearbox: 'automatic',
  drs_mode: 'auto',
  ers_mode: 'balanced',
}

export type WarningDisplayState = 'clear' | 'brake' | 'stale' | 'no_data'

export interface VehicleStateMessage {
  type: 'vehicle_state'
  seq: number
  t: number // simulation time (s)
  x: number
  y: number
  heading: number
  speed: number
  lap_progress: number
  sector_index: number
  sector_name: string
  distance_along_lap: number
  next_hazard_zone: string | null
  next_hazard_distance: number | null
  signed_clearance: number
  // the warning system's data path
  sample_age_ms: number | null
  warning_reason: string | null
  warning_state: WarningDisplayState
  true_grip: number
  estimated_grip: number
  track_exit: boolean
  lap_complete: boolean
  off_track: boolean
  track_exits: number
  barrier_contacts: number
  lap: number
  laps_completed: number
  lap_time_s: number
  last_lap_s: number | null
  best_lap_s: number | null
  session_best_lap_s?: number | null // best valid lap this session, kept across resets
  lap_valid?: boolean
  last_lap_valid?: boolean | null
  // car / power unit
  gear?: number // -1 = reverse
  rpm?: number
  battery_pct?: number
  ers_deploy_kw?: number
  drs_open?: boolean
  drs_available?: boolean
  tc_active?: boolean
  wheelspin?: boolean
  lockup?: boolean
  // what the wheels are on, from the simulator's surface model
  surface?: 'track' | 'kerb' | 'runoff' | 'grass'
  g_lat?: number
  g_long?: number
  setup?: CarSetupConfig
}

export interface WarningEventMessage {
  type: 'warning_event'
  seq: number
  active: boolean
  state: WarningDisplayState
  reason: string | null
  hazard_zone: string | null
  hazard_id: string | null
  advised_speed: number | null
  source: 'remote' | 'local' | null
  data_age_ms: number | null
  generated_t: number | null
  displayed_t: number
  source_t: number
}

export interface RunEventMessage {
  type: 'run_event'
  event: string
  t: number
  distance?: number
  location?: string | null
}

export interface SessionInfoMessage {
  type: 'session_info'
  session_id: string
  run_id: string // changes on every reset
  track: TrackId
}
