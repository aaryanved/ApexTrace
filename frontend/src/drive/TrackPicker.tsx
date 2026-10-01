import type { TrackId, TrackProfile } from '../types/schemas'
import './TrackPicker.css'

const BLURB: Record<TrackId, string> = {
  monza: 'Temple of Speed — long straights, heavy braking into chicanes, Parabolica.',
  baku: 'Street circuit — 90° corners, the narrow castle section, a 2 km flat-out run.',
}

function Outline({ profile }: { profile: TrackProfile }) {
  const xs = profile.centerline.map((p) => p[0])
  const ys = profile.centerline.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1
  const d =
    profile.centerline
      .filter((_, i) => i % 4 === 0)
      .map(([x, y], i) => `${i ? 'L' : 'M'}${(((x - minX) / span) * 90 + 5).toFixed(1)},${(((y - minY) / span) * 90 + 5).toFixed(1)}`)
      .join(' ') + ' Z'
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <path d={d} fill="none" stroke="#000" strokeWidth={5} strokeLinejoin="round" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinejoin="round" />
    </svg>
  )
}

interface TrackPickerProps {
  profiles: Record<TrackId, TrackProfile>
  value: TrackId
  onChange: (id: TrackId) => void
  onStart: () => void
  onOpenSetup?: () => void
}

export function TrackPicker({ profiles, value, onChange, onStart, onOpenSetup }: TrackPickerProps) {
  return (
    <div className="track-picker" role="dialog" aria-label="Choose a circuit">
      <h1>Choose your circuit</h1>
      <div className="track-picker__cards">
        {(['monza', 'baku'] as TrackId[]).map((id) => {
          const p = profiles[id]
          return (
            <button
              key={id}
              type="button"
              className={`track-picker__card ${value === id ? 'track-picker__card--on' : ''}`}
              onClick={() => onChange(id)}
              aria-pressed={value === id}
            >
              <div className="track-picker__map">
                <Outline profile={p} />
              </div>
              <strong>{p.name}</strong>
              <span>{`${(p.total_length / 1000).toFixed(3)} km · ${p.hazard_zones.length} corners`}</span>
              <small>{BLURB[id]}</small>
            </button>
          )
        })}
      </div>
      <div className="track-picker__footer">
        {onOpenSetup && (
          <button type="button" className="track-picker__setup" onClick={onOpenSetup}>
            Car setup
          </button>
        )}
        <button type="button" className="track-picker__go" onClick={onStart}>
          Start session
        </button>
      </div>
      <p className="track-picker__keys">
        W / ↑ throttle · S / ↓ / Space brake · A D / ← → steer · E / Q shift · F DRS · R reverse · B battery · a wheel is picked
        up automatically
      </p>
    </div>
  )
}
