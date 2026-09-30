// Swept vehicle/barrier contact using the same edge offsets as the renderer.
// The car is a 5.6 x 2 m rectangle. Contact stops it at the first impact:
// a solid-wall constraint, not a damage or rebound model.

import type { TrackProfile } from '../types/schemas'

const HALF_LENGTH = 2.8
const HALF_WIDTH = 1.0
const SKIN = 0.02
const CELL = 20.0

type Point = readonly [number, number]
type Segment = readonly [Point, Point]
type Grid = Map<string, Segment[]>

const grids = new WeakMap<TrackProfile, Grid>()

function barrierGrid(profile: TrackProfile): Grid {
  const cached = grids.get(profile)
  if (cached) return cached
  const normals: Point[] = profile.centerline.map(([cx, cy], i) => {
    const [lx, ly] = profile.left_edge[i]
    const length = Math.hypot(lx - cx, ly - cy) || 1.0
    return [(lx - cx) / length, (ly - cy) / length]
  })
  const grid: Grid = new Map()
  for (const [edge, side] of [
    [profile.left_edge, 1],
    [profile.right_edge, -1],
  ] as const) {
    // Python zips edge with normals: both are the length of the centerline
    const count = Math.min(edge.length, normals.length)
    const wall: Point[] = []
    for (let i = 0; i < count; i++) {
      const [x, y] = edge[i]
      const [nx, ny] = normals[i]
      wall.push([x + nx * profile.barrier_offset * side, y + ny * profile.barrier_offset * side])
    }
    const last = wall[wall.length - 1]
    if (last[0] !== wall[0][0] || last[1] !== wall[0][1]) wall.push(wall[0])
    for (let i = 0; i + 1 < wall.length; i++) {
      const a = wall[i]
      const b = wall[i + 1]
      const segment: Segment = [a, b]
      for (let gx = Math.floor(Math.min(a[0], b[0]) / CELL); gx <= Math.floor(Math.max(a[0], b[0]) / CELL); gx++) {
        for (let gy = Math.floor(Math.min(a[1], b[1]) / CELL); gy <= Math.floor(Math.max(a[1], b[1]) / CELL); gy++) {
          const key = `${gx},${gy}`
          const cell = grid.get(key)
          if (cell) cell.push(segment)
          else grid.set(key, [segment])
        }
      }
    }
  }
  grids.set(profile, grid)
  return grid
}

/** Continuous separating-axis test: moving rectangle vs a wall segment. */
function hitFraction(x: number, y: number, dx: number, dy: number, heading: number, padding: number, a: Point, b: Point): number | null {
  const fx = Math.cos(heading)
  const fy = Math.sin(heading)
  const sx = -fy
  const sy = fx
  const wx = b[0] - a[0]
  const wy = b[1] - a[1]
  const length = Math.hypot(wx, wy)
  if (length < 1e-9) return null
  let enter = 0.0
  let leave = 1.0
  for (const [nx, ny] of [
    [fx, fy],
    [sx, sy],
    [-wy / length, wx / length],
  ]) {
    const radius = (HALF_LENGTH + padding) * Math.abs(fx * nx + fy * ny) + (HALF_WIDTH + padding) * Math.abs(sx * nx + sy * ny)
    const p = a[0] * nx + a[1] * ny
    const q = b[0] * nx + b[1] * ny
    const center = x * nx + y * ny
    const velocity = dx * nx + dy * ny
    const lo = Math.min(p, q) - radius - center
    const hi = Math.max(p, q) + radius - center
    if (Math.abs(velocity) < 1e-12) {
      if (lo > 0 || hi < 0) return null
      continue
    }
    const t0 = lo / velocity
    const t1 = hi / velocity
    enter = Math.max(enter, Math.min(t0, t1))
    leave = Math.min(leave, Math.max(t0, t1))
    if (enter > leave) return null
  }
  return enter
}

/** A non-penetrating pose and contact flag, even across a whole wall. Small
 *  angular slices bound the rotating footprint; each slice sweeps
 *  continuously, so high speed cannot tunnel between samples. */
export function constrainMotion(
  profile: TrackProfile,
  x0: number,
  y0: number,
  heading0: number,
  x1: number,
  y1: number,
  heading1: number,
): [number, number, number, boolean] {
  const radius = Math.hypot(HALF_LENGTH, HALF_WIDTH) + SKIN
  const grid = barrierGrid(profile)
  const candidates = new Set<Segment>()
  for (let gx = Math.floor((Math.min(x0, x1) - radius) / CELL); gx <= Math.floor((Math.max(x0, x1) + radius) / CELL); gx++) {
    for (let gy = Math.floor((Math.min(y0, y1) - radius) / CELL); gy <= Math.floor((Math.max(y0, y1) + radius) / CELL); gy++) {
      for (const segment of grid.get(`${gx},${gy}`) ?? []) candidates.add(segment)
    }
  }
  if (candidates.size === 0) return [x1, y1, heading1, false]
  const angle = heading1 - heading0
  const slices = Math.max(1, Math.ceil(Math.abs(angle) / 0.02))
  const dx = (x1 - x0) / slices
  const dy = (y1 - y0) / slices
  const padding = SKIN + (radius * Math.abs(angle)) / slices / 2
  for (let i = 0; i < slices; i++) {
    const x = x0 + dx * i
    const y = y0 + dy * i
    const heading = heading0 + (angle * (i + 0.5)) / slices
    let first: number | null = null
    for (const [a, b] of candidates) {
      const hit = hitFraction(x, y, dx, dy, heading, padding, a, b)
      if (hit !== null && (first === null || hit < first)) first = hit
    }
    if (first !== null) {
      // Leave a tiny gap so a subsequent move away from the wall is free.
      const fraction = (i + Math.max(0.0, first - 1e-5)) / slices
      return [x0 + (x1 - x0) * fraction, y0 + (y1 - y0) * fraction, heading0 + angle * fraction, true]
    }
  }
  return [x1, y1, heading1, false]
}
