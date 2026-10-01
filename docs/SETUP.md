# ApexTrace: setup, controls and tests

A 2026-spec F1 driving simulator with an on-board BRAKE warning system:
drive full laps of Monza or Baku (real layouts, simplified 3D), and a safety
report scores how you reacted to every warning. Everything runs in the
browser; see [ARCHITECTURE.md](../ARCHITECTURE.md) for the design.

This is an F1-*inspired* prototype: a simplified vehicle model, **not** team
data or certification.

## Requirements

- Node.js 20+ and npm
- Google Chrome (only for the browser end-to-end test)
- Python 3 with `pyserial` and `websockets` (only for the ESP32 wheel bridge)

## First-time setup

```bash
cd frontend && npm install
```

**Detailed car model (optional, per machine):** the game draws
`frontend/public/models/car.glb` if it exists, and silently falls back to the
built-in car if not. Both it and the raw model are git-ignored (too big), so on
each machine drop the RB22 `.glb` into `frontend/public/` and run:

```bash
python3 scripts/optimize_car_model.py   # needs Pillow; writes public/models/car.glb
```

It caps textures at 1024 px (GPU texture memory ~391 MB → ~122 MB) and leaves
the meshes and material names alone, so the wheels still spin and steer. Refresh
the page afterwards: the game checks for the model once per page load.

## Run

```bash
cd frontend && npm run dev -- --host
```

Open `http://localhost:5173` and press **Start session**. The camera button
cycles cockpit, chase and overview; **Graphics: Quality / Performance** is
remembered per machine.

## Controls

| Action | Keyboard | Wheel / gamepad | ESP32 wheel |
| --- | --- | --- | --- |
| Throttle / brake | W / ↑, S / ↓ / Space | right / left trigger | joystick forward / back |
| Steer | A / ←, D / → | axis 0 | turn the wheel |
| Shift up / down (manual) | E / Q | RB / LB (paddles) | — |
| DRS / active aero (manual) | F | A | — |
| Reverse (when stopped) | R | X | — |
| Cycle battery mode | B | Y | — |
| Reset to grid | dock button | dock button | press the joystick down |
| Force feedback | — | rumble motors | 2x SG90 servos |

A wheel/gamepad is used automatically if the browser sees one (calibrate
centre and dead-zone in the Controls panel of the Drive screen). The view
button cycles cockpit, chase and overview cameras. **Graphics: Quality /
Performance** (Drive screen dock) is remembered per machine and applies to
every 3D view: Performance renders at 1x with no bloom/anti-aliasing effects,
for integrated GPUs such as Intel Iris Xe.

**ESP32 wheel** (`embedded-firmware/`): flash `steering-wheel/steering-wheel.ino`,
plug the ESP32 into the driver laptop, and run the serial-to-WebSocket bridge
alongside the app (`pip install pyserial websockets` once):

```bash
cd embedded-firmware && python bridge.py   # auto-detects the port; --list / --port to choose
```

Its live readout shows the steering, pedal and reset values it forwards, so
the hardware can be checked on its own. The Drive screen picks the wheel up
automatically (Controls panel: `Input: ESP32 wheel`); a plugged-in gamepad
takes priority. On Linux, reading the port needs the `dialout` group.
**Leave the joystick untouched while the wheel powers up:** the firmware
measures its rest point at boot (the Serial Monitor shows
`# joystick centre ...`), so a stick held during boot reads as drift.

**Wheel screen** (1.69" 240x280 ST7789V2, 4-wire SPI): GND→GND, VCC→3V3,
SCL→D18, SDA→D23, RES→D4, DC→D2, CS→D5, BLK→3V3. Needs the *Adafruit ST7735
and ST7789* and *Adafruit GFX* libraries; `testing/display_test` is a quick
bring-up sketch for the screen alone. It shows steering (a centre-zero bar and
the raw g value), throttle and brake, the live BRAKE / STALE warning or the
speed, and the actual send rate and packet number. The game's side of that
reaches the ESP32 back through the bridge. The top banner says where the chain
is broken:

| Banner | Meaning | Fix |
| --- | --- | --- |
| LIVE | in a session, driving with this wheel | — |
| NO BRIDGE | nothing from `bridge.py` for 1.5 s | start the bridge (and close the Serial Monitor) |
| NO GAME | bridge up, no Drive screen connected | open the app on the laptop |
| NO SESSION | Drive screen open, no session | press Start |
| WHEEL NOT IN USE | in a session, but another input is driving | unplug the gamepad, or check the wheel's data reaches the browser |

**Force feedback** (like a console pad's rumble): kerbs drum at the rate the
stripes pass under the wheels, run-off shakes irregularly, locked or spinning
wheels fizz, a barrier hit knocks hard and a new BRAKE warning taps twice. It
goes to whichever input is driving: the ESP32 wheel's two SG90 servos (below)
or an Xbox-style gamepad's motors (Chrome/Edge). The same signal drives what
you see: camera shake, sparks from the floor (kerbs, bottoming out at top
speed, heavy braking, barrier hits), tyre smoke and skid marks from locked or
spinning wheels, dust off the track, a red flash round the screen on impact,
and red chevrons painted down the road into the corner while BRAKE is shown.

**Wheel servos** (2x SG90, rumble): both signal wires -> D12, V+ -> **5 V**
(not 3V3), GND -> GND. Each can pull ~0.6 A when it reverses, which browns
out the ESP32 and its screen from 3V3: use a separate 5 V supply (or the
ESP32's 5V/VIN pin off a good USB port for short demos), with a 470-1000 uF
capacitor across the servos' V+ and GND. D12 is a boot strapping pin: if the
board won't boot with the servos attached, move the signal to D13/D14/D26/D27
and change `PIN_RUMBLE_SERVO` in `rumble.cpp`. The servos stop on their own
0.5 s after the game stops sending, and go limp (silent) when still.

**Car setup** (track picker or the dock during a run; applies immediately):
traction control Off/Medium/Full, ABS On/Off, automatic or manual
transmission, DRS Off/Auto/Manual, and battery power Harvest/Balanced/Overtake.

**Car model** (`frontend/src/sim/car.ts`): a simplified 2026-regulation car -
tyre slip and a friction circle (so braking or wheelspin costs cornering
grip), downforce and drag that grow with speed plus Z/X-mode active aero, a
400 kW engine through an 8-speed gearbox and a 350 kW MGU-K that fades above
290 km/h and runs on a 4 MJ battery recharged under braking. It reaches
0-100 km/h in about 2.6 s and 325-343 km/h. Plausible public figures, not team
data. Laps are timed against track limits (void once the whole car is past
the edge line) and the dash keeps the session's best valid lap.

**Driver safety report:** the Drive screen times your reaction to every BRAKE
warning (warning shown -> brake past 30 %), flags warnings ignored or
anticipated, and tracks the closest call, walls, off-tracks, best lap, top
speed and peak g. A chip under the BRAKE banner shows each reaction as it
happens; **Safety report** (and End session) opens the full report with a
0-100 safety score, every reaction charted, and a CSV download of the data.

## Tests

```bash
cd frontend && npm test          # unit tests, including the simulator against recorded Python sessions
cd frontend && npm run build && npx vite preview --port 4173
cd frontend && npm run e2e       # real Chrome: real-time simulation and wall impacts on both tracks
```

`src/sim/*.test.ts` replay steps and whole sessions recorded from the original
Python simulator (`src/sim/__fixtures__`, exported by
`backend/scripts/export_sim_fixtures.py` before the backend was retired; see
git history) and require every tick to match. `npm run e2e` needs Chrome;
`BASE=https://…` points it at a deployed build. Screenshots land in
`frontend/e2e/shots/` (git-ignored).

## Deploy

`npm run build` produces a static site in `frontend/dist`; it needs no server.
The live one is a Vercel project rooted at `frontend/`.

## Layout

```
frontend/src/sim/     the simulator: car.ts (dynamics), vehicle.ts (track, laps, surfaces),
                      barriers.ts, pipeline.ts (sensors -> warning computer -> display),
                      session.ts (one 20 Hz session), worker.ts (runs it off the main thread),
                      tracks/ (circuit geometry)
frontend/src/         the Drive screen: 3D scene, HUD, inputs, audio, haptics, safety report
embedded-firmware/    ESP32 wheel firmware and the serial-to-WebSocket bridge
scripts/              optimize_car_model.py (for the optional detailed car model)
```
