/// <reference types="node" />
// Test helper: the recorded Python fixtures (backend/scripts/export_sim_fixtures.py in git history).
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

export function loadFixture<T>(name: string): T {
  const path = new URL(`./__fixtures__/${name}.json.gz`, import.meta.url)
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T
}

/** Field-by-field comparison: numbers within a tolerance, everything else exact. */
export function diffFields(actual: Record<string, unknown>, expected: Record<string, unknown>, tol = 1e-9): string[] {
  const problems: string[] = []
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key]
    if (typeof want === 'number' && typeof got === 'number') {
      const scale = Math.max(1, Math.abs(want))
      if (!(Math.abs(got - want) <= tol * scale)) problems.push(`${key}: got ${got}, want ${want}`)
    } else if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(`${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    }
  }
  return problems
}
