import { describe, expect, it } from 'vitest'
import type { CarSetupConfig } from '../types/schemas'
import { diffFields, loadFixture } from './fixtures'
import { SimSession, type ControlInput } from './session'
import { TRACKS } from './tracks'

interface SessionFixture {
  track: 'monza' | 'baku'
  setup: CarSetupConfig
  ticks: { input: ControlInput & { command?: 'pause' | 'resume' | 'reset' }; messages: Record<string, unknown>[] }[]
}

// Python-only fields the browser session no longer produces (fault injection, the engineer's link).
const DROPPED = new Set(['injected_delay_ms', 'warning_path_delay_ms', 'warning_delivery_delay_ms', 'blackout', 'local_fallback_active'])

// Whole recorded Python sessions, replayed input by input: every message on every tick must match.
describe.each(['monza_lap', 'baku_lap', 'monza_loose', 'monza_raw', 'baku_manual'])('session matches Python: %s', (name) => {
  const fixture = loadFixture<SessionFixture>(`session_${name}`)

  it(`reproduces ${fixture.ticks.length} ticks`, () => {
    // session_info is filtered below: the Python server sent it at connect, not per tick
    const fresh = new SimSession(TRACKS[fixture.track], fixture.setup)
    const failures: string[] = []
    fixture.ticks.forEach((row, i) => {
      const { command, ...input } = row.input
      if (command === 'pause') fresh.pause()
      if (command === 'resume') fresh.resume()
      if (command === 'reset') fresh.reset()
      fresh.setControls(input)
      const got = fresh.tick().filter((m) => m.type !== 'session_info')
      const want = row.messages
      if (got.length !== want.length) {
        failures.push(`tick ${i}: ${got.map((m) => m.type)} vs ${want.map((m) => m.type)}`)
        return
      }
      want.forEach((w, k) => {
        const expected = Object.fromEntries(Object.entries(w).filter(([key]) => !DROPPED.has(key)))
        const problems = diffFields(got[k] as unknown as Record<string, unknown>, expected, 1e-6)
        if (problems.length) failures.push(`tick ${i} ${w.type}: ${problems.slice(0, 4).join('; ')}`)
      })
    })
    expect(failures.slice(0, 6)).toEqual([])
  })
})
