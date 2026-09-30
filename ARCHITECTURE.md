# Architecture

ApexTrace is a static web app: a React + React Three Fiber Drive screen and a
TypeScript simulator that runs in a Web Worker. There is no server.

```
input (keyboard / gamepad / ESP32 wheel via bridge.py)
   -> useInputAdapter -> useDriveSession --controls--> Web Worker: SimSession, 20 Hz
                                          <--messages-- vehicle_state / warning_event / session_info
   -> Scene (interpolated poses), HUD, warnings, audio, haptics, safety report
```

## Why a worker

The simulator's 20 Hz tick costs ~0.01 ms, but the 3D scene can take far longer
than 50 ms per frame on a weak or software-rendered GPU. On the main thread
that starved the physics timer and the car slowed down with the frame rate.
In the worker it keeps a fixed 50 ms deadline (catching up at most four ticks
after a stall), so the car always runs in real time; rendering interpolates
between the poses it receives (`scene/poseBuffer.ts`).

## Simulator (`frontend/src/sim`)

| File | What it does |
| --- | --- |
| `car.ts` | 2026-spec car dynamics (below) |
| `vehicle.ts` | the car on the track: nearest centreline point, clearance and surfaces (track / kerb / runoff / grass), lap progress, lap timing against track limits |
| `barriers.ts` | swept rectangle-vs-wall collision against the rendered barrier lines; contact stops the car |
| `pipeline.ts` | the BRAKE warning's data path: sensors (sample time per channel, grip estimate) -> warning service -> driver display |
| `session.ts` | one session: controls, button presses, pause / reset, and the messages each tick produces |
| `worker.ts` | runs a session on its own thread |
| `tracks/` | Monza and Baku centrelines, edges, sectors and corners |

It is a line-for-line port of the project's original Python simulator
(retired with the backend; see git history). `pyMath.ts` reproduces the
Python semantics the model depends on (`%` with the divisor's sign, `round`
with ties to even). The tests replay recorded Python steps and whole sessions
(`__fixtures__`) and require every tick to match.

### Car physics

`vehicle.step` drives the car through `car.stepCar`, integrated in 4 ms
substeps inside each 50 ms tick:

| Part | Model |
| --- | --- |
| Chassis | planar bicycle model: forward/lateral velocity and yaw rate; 800 kg, 3.4 m wheelbase, 46.5 % front weight; kinematic blend below ~7 m/s |
| Tyres | Pacejka-style lateral force vs slip angle (peak ~7 deg), friction circle with drive/brake force, locked/spinning tyres lose most lateral grip |
| Aero | ClA 3.75 / CdA 1.13 in Z-mode, 2.25 / 0.78 in X-mode (opens on straights, closes on braking); 44 % front balance |
| Load transfer | longitudinal, from the previous substep's acceleration |
| Power unit | 400 kW ICE with an rpm curve and limiter, 8 gears; 350 kW MGU-K fading 290-355 km/h (to 337 km/h in Overtake), 4 MJ battery, regen under braking, coast harvest |
| Aids | traction control Off/Medium/Full, ABS, automatic or manual gearbox (over-rev protection), DRS Off/Auto/Manual, battery Harvest/Balanced/Overtake, reverse gear |
| Steering | speed-sensitive range: full input asks slightly past the grip limit at speed |

The car's brakes are at 75 % of new (the baseline car). The warning system
assumes a constant nominal braking rate of 32 m/s^2: that simplification is
part of the system being tested. Numbers are plausible public 2026 figures,
not team data.

### The warning

Of every corner within 1.5 km, the warning service picks the one whose
braking point is most overdue:

    required = (v^2 - v_corner^2) / (2 * 32) + 0.35 v + 7 m

and shows **BRAKE** once the distance left is below it. It reads only sensor
channels, each stamped with its sample time; data older than 300 ms shows
**WARNING DATA STALE** instead, and an old "all clear" is never trusted.

## Drive screen (`frontend/src`)

- `drive/useDriveSession.ts`: starts the worker, streams controls to it, and
  folds its messages into React state (vehicle state, warning, trails).
- `scene/`: the 3D track, scenery, car, camera views and effects.
- `input/`: keyboard, gamepad and ESP32 wheel adapters, calibration.
- `haptics/`, `audio/`: force feedback and the engine sound, from the vehicle state.
- `drive/driverReport.ts`: reaction times to each BRAKE warning, incidents and the safety score.
