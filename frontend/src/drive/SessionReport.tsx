import { useMemo } from 'react'
import { formatLapTime } from '../scene/trackGeometry'
import type { TrackId } from '../types/schemas'
import { ASSUMED_REACTION_S, reportCsv, summarise, type DriverReport } from './driverReport'
import './SessionReport.css'

const lap = formatLapTime

const secs = (s: number | null) => (s === null ? '—' : `${s.toFixed(2)} s`)

function ScoreRing({ score, grade }: { score: number | null; grade: string | null }) {
  const r = 52
  const c = 2 * Math.PI * r
  const tone = score === null ? '#64748b' : score >= 85 ? '#22c55e' : score >= 70 ? '#2dd4bf' : score >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <svg className="session-report__ring" viewBox="0 0 128 128" role="img"
      aria-label={score === null ? 'Not scored yet' : `Safety score ${score} of 100, grade ${grade}`}>
      <circle cx="64" cy="64" r={r} stroke="rgba(255,255,255,0.1)" strokeWidth="10" fill="none" />
      {score !== null && (
        <circle cx="64" cy="64" r={r} stroke={tone} strokeWidth="10" fill="none" strokeLinecap="round"
          strokeDasharray={`${(c * score) / 100} ${c}`} transform="rotate(-90 64 64)" />
      )}
      <text x="64" y="62" textAnchor="middle" className="session-report__ring-score">{score ?? '—'}</text>
      <text x="64" y="86" textAnchor="middle" className="session-report__ring-grade">{grade ? `grade ${grade}` : 'not scored'}</text>
    </svg>
  )
}

// One bar per BRAKE warning: its reaction time against the band the stress
// suite's scripted driver is given. Ignored warnings are red stubs.
function ReactionChart({ report }: { report: DriverReport }) {
  const items = report.responses.slice(-24)
  if (items.length === 0) return <p className="session-report__empty">No BRAKE warnings this session.</p>
  const max = 1.2
  const y = (s: number) => 100 - (Math.min(s, max) / max) * 100
  const [fast, slow] = ASSUMED_REACTION_S
  const w = Math.min(100 / items.length, 7) // a lone warning is a bar, not a wall
  return (
    <svg className="session-report__chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
      aria-label="Reaction time for each BRAKE warning">
      <rect x="0" y={y(slow)} width="100" height={y(fast) - y(slow)} fill="rgba(45,212,191,0.18)" />
      {items.map((x, i) => {
        const cx = i * w + w * 0.2
        if (x.outcome === 'ignored') return <rect key={i} x={cx} y={0} width={w * 0.6} height={100} fill="rgba(239,68,68,0.28)" />
        const s = x.reactionS ?? 0
        const fill = x.outcome === 'anticipated' || s <= slow ? '#22c55e' : s <= 0.7 ? '#f59e0b' : '#ef4444'
        return <rect key={i} x={cx} y={y(Math.max(s, 0.03))} width={w * 0.6} height={100 - y(Math.max(s, 0.03))} fill={fill} rx="0.8" />
      })}
    </svg>
  )
}

interface Props {
  report: DriverReport
  track: TrackId
  trackName: string
  onClose: () => void
  onEnd: () => void
}

export function SessionReport({ report, track, trackName, onClose, onEnd }: Props) {
  const s = useMemo(() => summarise(report), [report])
  const minutes = Math.max(0, (Date.now() - report.startedAt) / 60000)

  return (
    <div className="session-report__backdrop" role="dialog" aria-modal="true" aria-label="Session report">
      <div className="session-report">
        <header className="session-report__head">
          <ScoreRing score={s.score} grade={s.grade} />
          <div>
            <p className="session-report__kicker">Driver safety report · {trackName}</p>
            <h2>
              {s.score === null
                ? 'Not tested yet'
                : s.score >= 85
                  ? 'Race-ready reactions'
                  : s.score >= 70
                    ? 'Solid, with margin to find'
                    : s.score >= 50
                      ? 'Some close calls'
                      : 'The warnings needed you sooner'}
            </h2>
            <p className="session-report__verdict">{s.verdict}</p>
          </div>
        </header>

        <div className="session-report__tiles">
          <div><span>Avg reaction</span><strong>{secs(s.reactionAvgS)}</strong><small>best {secs(s.reactionBestS)}</small></div>
          <div><span>Warnings heeded</span><strong>{s.heeded}/{s.warnings}</strong><small>{s.ignored ? `${s.ignored} ignored` : 'none ignored'}</small></div>
          <div>
            <span>Closest call</span>
            {report.minClearanceM !== null && report.minClearanceM < 0 ? (
              <>
                <strong className="session-report__bad">Off track</strong>
                <small>{Math.abs(report.minClearanceM).toFixed(1)} m past the edge</small>
              </>
            ) : (
              <>
                <strong>{report.minClearanceM === null ? '—' : `${report.minClearanceM.toFixed(1)} m`}</strong>
                <small>car centre to edge</small>
              </>
            )}
          </div>
          <div><span>Incidents</span><strong>{report.barrierHits + report.trackExits}</strong><small>{report.barrierHits} walls · {report.trackExits} off</small></div>
          <div><span>Best lap</span><strong>{lap(report.bestLapS)}</strong><small>{report.laps} laps · {minutes.toFixed(0)} min</small></div>
          <div><span>Top speed</span><strong>{Math.round(report.topSpeedKmh)} km/h</strong><small>peak {report.maxG.toFixed(1)} g</small></div>
        </div>

        <section>
          <h3>Reaction to every BRAKE warning <span className="session-report__legend">band: {ASSUMED_REACTION_S[0]}–{ASSUMED_REACTION_S[1]} s the stress suite assumes</span></h3>
          <ReactionChart report={report} />
        </section>


        <footer className="session-report__actions">
          <button
            type="button"
            className="session-report__download"
            disabled={report.responses.length === 0 && report.laps === 0}
            onClick={() => {
              const url = URL.createObjectURL(new Blob([reportCsv(report, trackName)], { type: 'text/csv' }))
              const a = document.createElement('a')
              a.href = url
              a.download = `apextrace-${track}-safety-report-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }}
          >
            Download my data (CSV)
          </button>
          <button type="button" onClick={onClose}>Keep driving</button>
          <button type="button" className="session-report__end" onClick={onEnd}>End session</button>
        </footer>
      </div>
    </div>
  )
}
