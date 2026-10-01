// Python semantics the simulator depends on. The physics was written (and its
// behaviour tuned) in Python, so these must match it exactly, not approximately.

/** Python `a % b`: the result has the sign of `b` (JS `%` keeps the sign of `a`). */
export function pyMod(a: number, b: number): number {
  const r = a % b
  return r !== 0 && r < 0 !== b < 0 ? r + b : r
}

/** Python `round(x)` / `round(x, digits)`: exact ties go to the even neighbour. */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x
  if (digits === 0) {
    const floor = Math.floor(x)
    const diff = x - floor
    if (diff === 0.5) return floor % 2 === 0 ? floor : floor + 1
    return Math.round(x)
  }
  // toFixed rounds the exact binary value, like Python; only exact decimal
  // ties (rare for measured floats) can differ, where Python picks even.
  return Number(x.toFixed(digits))
}

/** Python `f"{x:.0f}"`. */
export function pyFormat0(x: number): string {
  const r = pyRound(x)
  return Object.is(r, -0) || (r === 0 && x < 0) ? '-0' : String(r)
}

/** Python `math.copysign(x, y)`. */
export function copysign(x: number, y: number): number {
  const negative = y < 0 || Object.is(y, -0)
  return negative ? -Math.abs(x) : Math.abs(x)
}

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x))
