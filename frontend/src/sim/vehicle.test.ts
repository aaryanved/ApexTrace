import { describe, expect, it } from 'vitest'
import type { TrackProfile } from '../types/schemas'
import type { CarSetup, DriverRequests } from './car'
import { diffFields, loadFixture } from './fixtures'
import { TRACKS } from './tracks'
import { step, type VehicleState } from './vehicle'

interface StepFixture {
  track: 'monza' | 'baku'
  setup: CarSetup
  steps: {
    before: VehicleState
    steering: number
    throttle: number
    brake: number
    requests: DriverRequests
    brake_wear: number
    after: VehicleState
  }[]
}

// Every recorded Python step, reproduced from the same state and inputs.
describe.each(['monza_lap', 'baku_lap', 'monza_loose', 'monza_raw', 'baku_manual'])('vehicle step matches Python: %s', (name) => {
  const fixture = loadFixture<StepFixture>(`steps_${name}`)
  const profile: TrackProfile = TRACKS[fixture.track]

  it(`reproduces ${fixture.steps.length} steps`, () => {
    const failures: string[] = []
    fixture.steps.forEach((s, i) => {
      const after = step(s.before, s.steering, s.throttle, s.brake, 0.05, profile, {
        brakeWear: s.brake_wear,
        setup: fixture.setup,
        requests: s.requests,
      })
      const problems = diffFields(after as unknown as Record<string, unknown>, s.after as unknown as Record<string, unknown>)
      if (problems.length) failures.push(`step ${i}: ${problems.slice(0, 4).join('; ')}`)
    })
    expect(failures.slice(0, 5)).toEqual([])
  })
})
