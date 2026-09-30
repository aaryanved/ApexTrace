import { NO_RUMBLE, type HapticEvent, type Rumble } from '../../haptics/haptics'
import type { ButtonId, DeviceFeedback, InputAdapter, RawInputSample } from '../InputAdapter'
import { clamp } from '../normalize'
import { nextBackoffMs } from '../../stream/reconnect'
import { FULL_LOCK_G, WheelSteering } from '../steeringShaping'

// Shape the ESP32 wheel pushes over WebSocket (via embedded-firmware/bridge.py,
// which reads the serial stream and re-broadcasts it as JSON).
export interface HardwareInputMessage {
  source: 'esp32' | 'pi-zero'
  sequence: number
  timestamp: number
  steeringRaw: number
  throttleRaw: number
  brakeRaw: number
  // HW-504 push-button (SW -> D25). Optional so firmware predating it still works.
  resetPressed?: boolean
}

export const BRIDGE_PORT = 8765

// The bridge runs on the machine serving the page (the wheel's USB host). Set
// VITE_HARDWARE_WS_URL when the ESP32 is plugged into a different machine.
// Resolved lazily: read at module load this would make the module unimportable
// outside a browser.
export function bridgeUrl(): string {
  const override = import.meta.env.VITE_HARDWARE_WS_URL
  if (override) return override
  const host = typeof window === 'undefined' ? 'localhost' : window.location.hostname
  return `ws://${host}:${BRIDGE_PORT}`
}

// Full-lock reading from the averaged MPU pair, in g. The firmware reports
// gravity's projection on the wheel's Y axis (~±0.8 g at full lock), while
// normalize.ts assumes a device spanning ±1 — adapters convert into that
// shared convention, see InputAdapter.ts.
export const STEERING_FULL_SCALE = FULL_LOCK_G

// The firmware sends at 50 Hz (delay(20)). If samples stop arriving the last
// one must NOT be held: a frozen packet at full throttle would keep the car
// accelerating with the wheel unplugged.
export const STALE_AFTER_MS = 500

// The firmware hardcodes the HW-504 centre to 2048, but real sticks idle a
// little off that, which would read as permanent throttle or brake — the
// deadzone slider in the calibration panel only applies to steering.
const PEDAL_DEADZONE = 0.06

const AVAILABILITY_POLL_MS = 100

// useInputAdapter counts a press on each rising edge of pollButtons(), with no
// lockout of its own (a double count there would double-shift). This switch
// is mechanical, so a release shorter than this is treated as still held:
// contact bounce and small gaps in the 50 Hz stream stay one press, not two.
export const RESET_RELEASE_DEBOUNCE_MS = 100

const NO_FEEDBACK: DeviceFeedback = { active: false, session: 'none', warning: 'clear', speedKmh: null }

// The fields worth sending the instant they change (a BRAKE warning must not
// wait for the next heartbeat); speed rides along on the 10 Hz heartbeat.
const feedbackKey = (f: DeviceFeedback) => `${f.active}|${f.session}|${f.warning}`

// Wire format bridge.py expects; snake_case like the rest of its protocol.
export function feedbackMessage(f: DeviceFeedback): string {
  return JSON.stringify({
    type: 'feedback',
    active: f.active,
    session: f.session,
    warning: f.warning,
    speed_kmh: f.speedKmh === null ? null : Math.round(f.speedKmh),
  })
}

// Rumble for the wheel's servos (via bridge.py -> "#R" lines). Sent the
// moment it changes by a noticeable step, and re-sent on the 10 Hz heartbeat
// while it lasts: the firmware stops the servos by itself 0.5 s after the last
// one, so a closed tab or a dead bridge can't leave them buzzing.
const rumbleKey = (r: Rumble) =>
  r.effect === 'none' ? 'none' : `${r.effect}|${Math.round(r.strength * 10)}|${Math.round(r.rateHz)}`

export function rumbleMessage(r: Rumble): string {
  return JSON.stringify({
    type: 'rumble',
    effect: r.effect,
    strength: Math.round(r.strength * 100) / 100,
    rate_hz: Math.round(r.rateHz),
  })
}

export function hapticEventMessage(e: HapticEvent): string {
  return JSON.stringify({ type: 'haptic_event', kind: e.kind, strength: Math.round(e.strength * 100) / 100 })
}

function pedal(raw: number): number {
  if (!Number.isFinite(raw)) return 0
  const magnitude = clamp(raw, 0, 1)
  if (magnitude <= PEDAL_DEADZONE) return 0
  return (magnitude - PEDAL_DEADZONE) / (1 - PEDAL_DEADZONE)
}


/**
 * Live ESP32 wheel over the serial->WebSocket bridge.
 *
 * `onAvailabilityChange` matters: the socket opens (and goes stale) long after
 * the adapter is created, so the caller has to re-run its adapter choice when
 * availability flips — otherwise the hardware is passed over once at startup
 * and never looked at again.
 */
export function createHardwareAdapter(onAvailabilityChange?: () => void): InputAdapter {
  const latest: RawInputSample = { steeringRaw: 0, throttleRaw: 0, brakeRaw: 0 }
  // tilt -> angle, One-Euro filtered, response curve: see steeringShaping.ts
  const wheel = new WheelSteering()
  let available = false
  // -Infinity, not 0: a real performance.now() can legitimately be 0, so 0 is
  // not usable as a "nothing received yet" sentinel.
  let lastMessageAt = Number.NEGATIVE_INFINITY
  // When the joystick was last reported pressed (same -Infinity sentinel).
  let resetSeenAt = Number.NEGATIVE_INFINITY
  let attempt = 0
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let feedback = NO_FEEDBACK
  let sentKey: string | null = null
  let rumble = NO_RUMBLE
  let sentRumbleKey: string | null = null

  const sendRumble = () => {
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(rumbleMessage(rumble))
    sentRumbleKey = rumbleKey(rumble)
  }

  // Also the browser's heartbeat to the bridge: sent while the socket is open
  // whether or not the ESP32's own data is currently fresh.
  const sendFeedback = () => {
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(feedbackMessage(feedback))
    sentKey = feedbackKey(feedback)
  }

  const fresh = () => performance.now() - lastMessageAt < STALE_AFTER_MS

  const refresh = () => {
    const next = socket?.readyState === WebSocket.OPEN && fresh()
    if (next === available) return
    available = next
    if (!available) {
      latest.steeringRaw = 0
      latest.throttleRaw = 0
      latest.brakeRaw = 0
      resetSeenAt = Number.NEGATIVE_INFINITY
      wheel.reset() // a reconnect must not ease in from wherever the wheel was
    }
    onAvailabilityChange?.()
  }

  // Watches for the *stale* edge too, which no socket event reports, and
  // doubles as the 10 Hz feedback heartbeat.
  const watchdog = setInterval(() => {
    refresh()
    sendFeedback()
    if (rumble.effect !== 'none') sendRumble()  // keep-alive, see rumbleMessage
  }, AVAILABILITY_POLL_MS)

  function connect() {
    if (disposed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(bridgeUrl())
    } catch {
      // An HTTPS page (the hosted build) may not open the bridge's ws:// URL;
      // the constructor throws instead of failing the socket. No wheel there,
      // and retrying would throw again, so stay unavailable.
      return
    }
    socket = ws

    ws.onopen = () => {
      if (disposed || socket !== ws) return
      attempt = 0
      sentRumbleKey = null
      sendFeedback()  // the wheel's screen shouldn't wait a heartbeat to learn the state
    }

    ws.onmessage = (event: MessageEvent<string>) => {
      if (disposed || socket !== ws) return
      try {
        const data = JSON.parse(event.data) as HardwareInputMessage
        latest.steeringRaw = wheel.update(data.steeringRaw, performance.now() / 1000)
        latest.throttleRaw = pedal(data.throttleRaw)
        latest.brakeRaw = pedal(data.brakeRaw)
        lastMessageAt = performance.now()
        if (data.resetPressed === true) resetSeenAt = lastMessageAt
        refresh()
      } catch {
        // malformed/torn line forwarded by the bridge — keep the last good sample
      }
    }

    ws.onclose = () => {
      if (disposed || socket !== ws) return
      refresh()
      // The bridge or the ESP32 may be restarted mid-session, so keep trying.
      retry = setTimeout(connect, nextBackoffMs(attempt++))
    }

    ws.onerror = () => {
      // onclose always follows, which schedules the retry above.
    }
  }

  connect()

  return {
    id: 'hardware',
    // A getter, not a snapshot: availability is decided after construction.
    get label() {
      return available ? 'ESP32 wheel' : 'ESP32 wheel (not connected)'
    },
    isAvailable: () => available,
    poll(): RawInputSample {
      // Never hand back a stale sample — see STALE_AFTER_MS.
      if (!available) return { steeringRaw: 0, throttleRaw: 0, brakeRaw: 0 }
      // A copy, not `latest` itself: the caller stores this in React state, and
      // handing back one object that is mutated in place would compare equal
      // every frame and suppress the re-render that moves the car.
      return { ...latest }
    },
    pollButtons(): ButtonId[] {
      // Only `reset` exists on this wheel. Stale data never holds it down.
      if (!available) return []
      return performance.now() - resetSeenAt < RESET_RELEASE_DEBOUNCE_MS ? ['reset'] : []
    },
    setFeedback(next: DeviceFeedback) {
      feedback = next
      if (feedbackKey(next) !== sentKey) sendFeedback()
    },
    setRumble(next: Rumble) {
      rumble = next
      if (rumbleKey(next) !== sentRumbleKey) sendRumble()
    },
    hapticEvent(event: HapticEvent) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(hapticEventMessage(event))
    },
    dispose() {
      disposed = true
      if (rumble.effect !== 'none') {
        rumble = NO_RUMBLE
        sendRumble()  // stop now rather than on the firmware's timeout
      }
      clearInterval(watchdog)
      clearTimeout(retry)
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
        socket.close()
        socket = null
      }
    },
  }
}
