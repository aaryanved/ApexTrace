/// <reference lib="webworker" />
// Runs the simulator on its own thread, so physics keeps real time however
// long the 3D scene takes to draw a frame (a slow GPU used to slow the car).

import type { CarSetupConfig, TrackId } from '../types/schemas'
import { SimSession, TICK_DT, type ControlInput, type SimMessage } from './session'
import { TRACKS } from './tracks'

export type ToWorker =
  | { type: 'start'; track: TrackId; setup: CarSetupConfig }
  | { type: 'controls'; input: ControlInput }
  | { type: 'setup'; setup: CarSetupConfig }
  | { type: 'pause' | 'resume' | 'reset' | 'stop' }

/** Everything one tick produced. */
export interface FromWorker {
  messages: SimMessage[]
}

const TICK_MS = TICK_DT * 1000
// After a stall (a suspended tab) resume where the car was instead of fast-forwarding.
const MAX_CATCH_UP_TICKS = 4

let session: SimSession | null = null
let timer: ReturnType<typeof setInterval> | null = null

function stop() {
  if (timer !== null) clearInterval(timer)
  timer = null
  session = null
}

function run(s: SimSession) {
  let next = performance.now()
  timer = setInterval(() => {
    const now = performance.now()
    if (now - next > MAX_CATCH_UP_TICKS * TICK_MS) next = now - MAX_CATCH_UP_TICKS * TICK_MS
    while (next <= now) {
      next += TICK_MS
      self.postMessage({ messages: s.tick() } satisfies FromWorker)
    }
  }, TICK_MS / 4)
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const command = event.data
  switch (command.type) {
    case 'start':
      stop()
      session = new SimSession(TRACKS[command.track], command.setup)
      run(session)
      break
    case 'controls':
      session?.setControls(command.input)
      break
    case 'setup':
      session?.setSetup(command.setup)
      break
    case 'pause':
      session?.pause()
      break
    case 'resume':
      session?.resume()
      break
    case 'reset':
      session?.reset()
      break
    case 'stop':
      stop()
      break
  }
}
