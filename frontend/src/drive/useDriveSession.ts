import { useCallback, useEffect, useRef, useState } from 'react'
import type { ButtonCounts, NormalizedControls } from '../input/useInputAdapter'
import { TICK_DT, type ControlInput, type SimMessage } from '../sim/session'
import { TRACKS } from '../sim/tracks'
import type { FromWorker, ToWorker } from '../sim/worker'
import { applyWarningEvent, INITIAL_WARNING, type WarningState } from '../stream/warningState'
import { DEFAULT_CAR_SETUP, type CarSetupConfig, type ErsMode, type TrackId, type VehicleStateMessage } from '../types/schemas'

export type ConnectionState = 'idle' | 'connected'

const CONTROL_INTERVAL_MS = TICK_DT * 1000 // also sent on every change; this catches button presses
const SETUP_KEY = 'limitlab.carSetup'
const ERS_ORDER: ErsMode[] = ['harvest', 'balanced', 'overtake']
const MAX_TRAIL_POINTS = 2000

type Point = [number, number]

function loadSetup(): CarSetupConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null')
    return saved ? { ...DEFAULT_CAR_SETUP, ...saved } : DEFAULT_CAR_SETUP
  } catch {
    return DEFAULT_CAR_SETUP
  }
}

// Runs the driver's session in the browser. The simulator (src/sim) steps at
// 20 Hz in a Web Worker, so a slow frame can't slow the car; this hook sends
// it the controls and folds what each tick produced into React state.

interface ActiveSession {
  id: string
  track: TrackId
  worker: Worker
}

const newSessionId = () => Math.random().toString(16).slice(2, 10)
export function useDriveSession(
  normalizedControls: NormalizedControls,
  buttonCounts?: React.MutableRefObject<ButtonCounts>,
  ersPresses = 0,
  resetPresses = 0,
) {
  const [selectedTrack, setSelectedTrack] = useState<TrackId>('monza')
  const [session, setSession] = useState<ActiveSession | null>(null)
  const [running, setRunning] = useState(true)
  const [setup, setSetupState] = useState<CarSetupConfig>(loadSetup)
  const [vehicleState, setVehicleState] = useState<VehicleStateMessage | null>(null)
  const [warning, setWarning] = useState<WarningState>(INITIAL_WARNING)
  const [trail, setTrail] = useState<Point[]>([])
  const [previousLapTrail, setPreviousLapTrail] = useState<Point[]>([])

  const controlsRef = useRef(normalizedControls)
  controlsRef.current = normalizedControls

  const start = useCallback(() => {
    if (session) return
    const worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' })
    worker.postMessage({ type: 'start', track: selectedTrack, setup } satisfies ToWorker)
    setRunning(true)
    setSession({ id: newSessionId(), track: selectedTrack, worker })
  }, [session, selectedTrack, setup])

  const post = useCallback((command: ToWorker) => session?.worker.postMessage(command), [session])

  const endSession = useCallback(() => setSession(null), [])

  // What each tick produced -> React state.
  useEffect(() => {
    setVehicleState(null)
    setWarning(INITIAL_WARNING)
    setTrail([])
    setPreviousLapTrail([])
    if (!session) return

    let trailPoints: Point[] = []
    let runId: string | null = null
    const apply = (message: SimMessage) => {
      switch (message.type) {
        case 'vehicle_state': {
          setVehicleState(message)
          trailPoints = [...trailPoints, [message.x, message.y] as Point].slice(-MAX_TRAIL_POINTS)
          setTrail(trailPoints)
          break
        }
        case 'warning_event':
          setWarning((prev) => applyWarningEvent(prev, message, Date.now()))
          break
        case 'session_info':
          // a reset starts a new run: keep the old line as the previous lap
          if (runId !== null && runId !== message.run_id && trailPoints.length > 1) setPreviousLapTrail(trailPoints)
          if (runId !== message.run_id) trailPoints = []
          runId = message.run_id
          break
        case 'run_event':
          break
      }
    }
    session.worker.onmessage = (event: MessageEvent<FromWorker>) => event.data.messages.forEach(apply)
    return () => session.worker.terminate()
  }, [session])

  // Controls: on every change, and on a steady beat for the button counters.
  const sendControls = useCallback(() => {
    const c = controlsRef.current
    const b = buttonCounts?.current
    const input: ControlInput = {
      steering: c.steering,
      throttle: c.throttle,
      brake: c.brake,
      shift_up_count: b?.shiftUp ?? 0,
      shift_down_count: b?.shiftDown ?? 0,
      drs_toggle_count: b?.drs ?? 0,
      reverse_toggle_count: b?.reverse ?? 0,
    }
    post({ type: 'controls', input })
  }, [post, buttonCounts])
  useEffect(() => {
    sendControls()
  }, [normalizedControls, sendControls])
  useEffect(() => {
    if (!session) return
    const id = setInterval(sendControls, CONTROL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [session, sendControls])

  // Setup changes apply live, and are remembered on this device.
  const setupRef = useRef(setup)
  setupRef.current = setup
  const setSetup = useCallback(
    (next: CarSetupConfig) => {
      setSetupState(next)
      post({ type: 'setup', setup: next })
      try {
        localStorage.setItem(SETUP_KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable: setting still applies to this session */
      }
    },
    [post],
  )

  // Battery-mode button cycles Harvest -> Balanced -> Overtake.
  const ersSeen = useRef(ersPresses)
  useEffect(() => {
    if (ersPresses === ersSeen.current) return
    ersSeen.current = ersPresses
    const current = setupRef.current
    const next = ERS_ORDER[(ERS_ORDER.indexOf(current.ers_mode) + 1) % ERS_ORDER.length]
    setSetup({ ...current, ers_mode: next })
  }, [ersPresses, setSetup])

  const togglePause = useCallback(() => {
    if (!session) return
    post({ type: running ? 'pause' : 'resume' })
    setRunning(!running)
  }, [session, post, running])

  const reset = useCallback(() => {
    if (!session) return
    post({ type: 'reset' })
    setRunning(true)
  }, [session, post])

  // The ESP32 wheel's joystick press does what "Reset to grid" does.
  const resetSeen = useRef(resetPresses)
  useEffect(() => {
    if (resetPresses === resetSeen.current) return
    resetSeen.current = resetPresses
    reset()
  }, [resetPresses, reset])

  return {
    setup,
    setSetup,
    selectedTrack,
    selectTrack: setSelectedTrack,
    connectionState: (session ? 'connected' : 'idle') as ConnectionState,
    sessionId: session?.id ?? null,
    trackProfile: session ? TRACKS[session.track] : null,
    vehicleState,
    warning,
    trail,
    previousLapTrail,
    running,
    start,
    endSession,
    togglePause,
    reset,
  }
}
