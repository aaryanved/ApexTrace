import { Canvas } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CalibrationPanel } from '../components/CalibrationPanel'
import { Icon } from '../components/Icon'
import { BrakeWarning } from '../drive/BrakeWarning'
import { CarSetupPanel } from '../drive/CarSetupPanel'
import { DriveHud } from '../drive/DriveHud'
import { RunStateBanner } from '../drive/RunStateBanner'
import { TelemetryPanel } from '../drive/TelemetryPanel'
import { TrackPicker } from '../drive/TrackPicker'
import { useDriveSession } from '../drive/useDriveSession'
import { useInputAdapter, type GameState } from '../input/useInputAdapter'
import { warnedHazard } from '../haptics/haptics'
import { useHaptics } from '../haptics/useHaptics'
import { ReactionToast } from '../drive/ReactionToast'
import { SessionReport } from '../drive/SessionReport'
import { useDriverReport } from '../drive/useDriverReport'
import { GhostRecorder } from '../drive/ghostLap'
import { setGraphicsMode, useGraphicsMode } from '../app/graphics'
import { useEngineSound } from '../audio/useEngineSound'
import { Scene, type SceneView } from '../scene/Scene'
import { TRACKS } from '../sim/tracks'
import './DriveScreen.css'

// The view button cycles cockpit -> chase -> overview -> cockpit; its label names the next view.
const NEXT_VIEW: Record<SceneView, SceneView> = { cockpit: 'follow', follow: 'overview', overview: 'cockpit' }
const VIEW_BUTTON_LABEL: Record<SceneView, string> = {
  cockpit: 'Chase cam',
  follow: 'Overview',
  overview: 'Cockpit',
}

export function DriveScreen() {
  const input = useInputAdapter()
  const session = useDriveSession(input.normalized, input.buttonCounts, input.presses.ersCycle, input.presses.reset)
  // Retina screens: start at 1.5x, drop to 1x if the frame rate can't keep up.
  // The Performance graphics setting pins 1x with no effects instead: a GPU
  // that strains but holds its frame rate never trips that automatic drop.
  const [dpr, setDpr] = useState(1.5)
  const lowGraphics = useGraphicsMode() === 'performance'
  const { connectionState } = session

  const [viewOverride, setViewOverride] = useState<SceneView | null>(null)
  const [showControls, setShowControls] = useState(false)
  const [showRacingLine, setShowRacingLine] = useState(true)
  const [showSetup, setShowSetup] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [showGhost, setShowGhost] = useState(true)
  const steeringRef = useRef(0)
  steeringRef.current = input.normalized.steering

  const profile = session.trackProfile ?? TRACKS[session.selectedTrack]
  const inSession = session.sessionId !== null
  const view: SceneView = viewOverride ?? (inSession ? 'cockpit' : 'overview')

  const v = session.vehicleState

  // Tell the ESP32 wheel's screen what the game is doing: its connection
  // banner, BRAKE light and speed. `input.source` is a dependency so the
  // "is this wheel the one driving?" flag is re-sent whenever the input in use
  // changes (e.g. a gamepad is plugged in).
  const gameSession: GameState['session'] = connectionState === 'idle' ? 'none' : 'connected'
  const gameWarning: GameState['warning'] = session.warning.active
    ? 'brake'
    : session.warning.stale
      ? 'stale'
      : 'clear'
  const speedKmh = v ? Math.round(Math.abs(v.speed) * 3.6) : null // |v|: reverse is negative
  const { reportGameState, source: inputSource } = input
  useEffect(() => {
    reportGameState({ session: gameSession, warning: gameWarning, speedKmh })
  }, [reportGameState, gameSession, gameWarning, speedKmh, inputSource])

  // Force feedback: kerbs, run-off, wheel slip, barrier hits and the BRAKE
  // warning rumble the wheel's servos or the gamepad, and drive the scene's
  // camera shake, sparks, smoke and skid marks.
  const { reportHaptics } = input
  const haptics = useHaptics({
    vehicleState: v,
    profile,
    warningActive: session.warning.active,
    live: connectionState === 'connected',
    reportHaptics,
  })
  // The human side of the test: reaction to each BRAKE warning, incidents,
  // best lap; shown live and as a report (with the leaderboard) on End session.
  const sound = useEngineSound(v, input.normalized.throttle, connectionState === 'connected' && session.running)
  const report = useDriverReport(session.sessionId, v, session.warning, input.normalized.brake)
  const endWithReport = () => (report.responses.length > 0 || report.laps > 0 ? setShowReport(true) : session.endSession())

  // Best-lap ghost: a see-through car replaying the session's best valid lap
  // against the current lap clock.
  const ghostLap = useMemo(() => new GhostRecorder(), [])
  useEffect(() => ghostLap.reset(), [session.sessionId, ghostLap])
  useEffect(() => {
    if (v) ghostLap.push(v)
  }, [v, ghostLap])
  const ghostPose = showGhost && v && !lowGraphics ? ghostLap.poseAt(v.lap_time_s) : null

  const brakeHazard =
    session.warning.active && profile ? warnedHazard(profile, session.warning.hazardZone, v?.next_hazard_zone ?? null) : null

  return (
    <div className="drive-screen" data-connection={connectionState}>
      <Canvas shadows={lowGraphics ? false : 'percentage'} camera={{ position: [400, 500, 400], fov: 50, near: 0.5, far: 8000 }} dpr={lowGraphics ? 1 : dpr}>
        {!lowGraphics && <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(1.5)} />}
        <Scene
          view={view}
          trackProfile={profile}
          vehicleState={v ? { x: v.x, y: v.y, heading: v.heading, speed: v.speed, drsOpen: v.drs_open, t: v.t } : null}
          trail={session.trail}
          previousLapTrail={session.previousLapTrail}
          steering={steeringRef}
          showRacingLine={showRacingLine && inSession}
          effects={!lowGraphics && dpr > 1}
          haptics={inSession ? haptics.signal : undefined}
          ghost={ghostPose}
          brakeHazard={brakeHazard}
          wet={v && inSession ? Math.max(0, Math.min(1, (1 - v.true_grip) / 0.4)) : 0}
        />
      </Canvas>
      {/* barrier hit: a red flash round the screen edge (keyed, so each hit replays it) */}
      {haptics.impacts > 0 && <div key={haptics.impacts} className="drive-screen__impact" aria-hidden="true" />}

      {!inSession && (
        <TrackPicker
          profiles={TRACKS}
          value={session.selectedTrack}
          onChange={session.selectTrack}
          onStart={session.start}
          onOpenSetup={() => setShowSetup(true)}
        />
      )}

      {inSession && (
        <>
          <div className="drive-screen__brand">
            <strong>{profile?.name}</strong>
          </div>

          <BrakeWarning warning={session.warning} />
          <ReactionToast latest={report.responses.at(-1)} />
          <RunStateBanner vehicleState={v} />
          <DriveHud normalized={input.normalized} vehicleState={v} profile={profile} sessionId={session.sessionId} />
          <TelemetryPanel normalized={input.normalized} vehicleState={v} />

          <div className="drive-screen__dock">
            <div className="drive-screen__group">
              <span className="drive-screen__caption">Session</span>
              <button type="button" onClick={session.togglePause} disabled={connectionState !== 'connected'}>
                <Icon name={session.running ? 'pause' : 'play'} />
                {session.running ? 'Pause' : 'Resume'}
              </button>
              <button type="button" onClick={session.reset} disabled={connectionState !== 'connected'}>
                <Icon name="reset" />
                Reset to grid
              </button>
              <button type="button" onClick={() => setShowReport(true)} aria-pressed={showReport}>
                <Icon name="report" />
                Safety report
              </button>
            </div>
            <div className="drive-screen__group">
              <span className="drive-screen__caption">View</span>
              <button type="button" onClick={() => setViewOverride(NEXT_VIEW[view])}>
                <Icon name="camera" />
                {VIEW_BUTTON_LABEL[view]}
              </button>
              <button type="button" onClick={() => setShowRacingLine((s) => !s)} aria-pressed={showRacingLine}>
                <Icon name="route" />
                Racing line
              </button>
              <button
                type="button"
                onClick={() => setShowGhost((s) => !s)}
                aria-pressed={showGhost}
                title="Replays your best valid lap this session as a see-through car (Quality graphics)"
              >
                <Icon name="ghost" />
                Best-lap ghost
              </button>
              <button
                type="button"
                onClick={() => setGraphicsMode(lowGraphics ? 'quality' : 'performance')}
                aria-pressed={lowGraphics}
                title="Performance: 1x resolution, no shadows or bloom/anti-aliasing effects — for integrated GPUs"
              >
                <Icon name="sparkle" />
                {lowGraphics ? 'Graphics: Performance' : 'Graphics: Quality'}
              </button>
              <button type="button" onClick={sound.toggle} aria-pressed={sound.on} title="Engine and tyre sound">
                <Icon name="sound" />
                {sound.on ? 'Sound: On' : 'Sound: Off'}
              </button>
            </div>
            <div className="drive-screen__group">
              <span className="drive-screen__caption">Car</span>
              <button type="button" onClick={() => setShowSetup((s) => !s)} aria-pressed={showSetup}>
                <Icon name="sliders" />
                Car setup
              </button>
              <button type="button" onClick={() => setShowControls((s) => !s)} aria-pressed={showControls}>
                <Icon name="gamepad" />
                Controls
              </button>
            </div>
            <button type="button" className="drive-screen__end" onClick={endWithReport}>
              <Icon name="exit" />
              End session
            </button>
          </div>
        </>
      )}

      {showReport && inSession && session.selectedTrack && (
        <SessionReport
          report={report}
          track={session.selectedTrack}
          trackName={profile?.name ?? session.selectedTrack}
          onClose={() => setShowReport(false)}
          onEnd={() => {
            setShowReport(false)
            session.endSession()
          }}
        />
      )}

      {showSetup && (
        <div className="drive-screen__setup">
          <CarSetupPanel setup={session.setup} onChange={session.setSetup} onClose={() => setShowSetup(false)} />
        </div>
      )}

      {showControls && (
        <CalibrationPanel
          source={input.source}
          raw={input.raw}
          normalized={input.normalized}
          calibration={input.calibration}
          setCenter={input.setCenter}
          setDeadzone={input.setDeadzone}
        />
      )}
    </div>
  )
}
