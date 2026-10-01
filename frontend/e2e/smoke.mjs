// End-to-end check of the built game in real Chrome: no server besides the page.
//   Run: npm run build && npx vite preview --port 4173, then node e2e/smoke.mjs
//   (BASE=... to point elsewhere, e.g. the deployed site)
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://localhost:4173'
// Walls stand this far outside each track's edge line (src/sim/tracks/*.json).
const BARRIER_OFFSET = { Monza: 14.0, 'Baku City': 1.5 }
const CAR_HALF_WIDTH = 1.0 // the collision box is 2 m wide
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  defaultViewport: { width: 1440, height: 900 },
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// The newest tick the page has received.
const latest = async (page) => {
  const [, t, speed, contacts] = await page.evaluate(() => window.__ticks.at(-1))
  return { t, kmh: speed * 3.6, contacts }
}

mkdirSync('e2e/shots', { recursive: true })
try {
  for (const track of ['Monza', 'Baku City']) {
    const page = await browser.newPage()
    // Record (arrival time, simulation time) of every tick the worker sends.
    await page.evaluateOnNewDocument(() => {
      window.__ticks = []
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args)
          this.addEventListener('message', (e) => {
            for (const m of e.data.messages) if (m.type === 'vehicle_state') window.__ticks.push([performance.now() / 1000, m.t, m.speed, m.barrier_contacts, m.signed_clearance])
          })
        }
      }
    })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(BASE, { waitUntil: 'networkidle2' })
    const click = (name) =>
      page.evaluate((text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text)).click(), name)
    await click(track)
    await click('Start session')
    await page.waitForSelector('.drive-screen[data-connection="connected"]')

    // The simulator runs in a worker: its clock keeps up with the wall clock
    // even while software rendering makes every frame slow. Ticks queue up
    // while the page is busy, so compare the least-delayed arrivals at the
    // start and end of the window.
    await sleep(10000)
    const ticks = await page.evaluate(() => window.__ticks)
    const lag = ([arrived, t]) => arrived - t
    const [w0, w1] = [ticks[0][0], ticks.at(-1)[0]]
    const earliest = (inWindow) => ticks.filter(inWindow).sort((x, y) => lag(x) - lag(y))[0]
    const a = earliest(([w]) => w < w0 + 3)
    const b = earliest(([w]) => w > w1 - 3)
    const ratio = (b[1] - a[1]) / (b[0] - a[0])
    assert(ratio > 0.97 && ratio < 1.03, `${track}: simulation ran at ${ratio.toFixed(3)}x real time`)

    // A busy page can take a few seconds to pass the key press to the car,
    // so wait for the speed rather than a fixed time.
    await page.keyboard.down('w')
    const throttleDeadline = Date.now() + 15000
    while ((await latest(page)).kmh <= 120 && Date.now() < throttleDeadline) await sleep(200)
    const { kmh } = await latest(page)
    assert(kmh > 120, `${track}: only ${Math.round(kmh)} km/h under full throttle`)

    // Steer into the wall: contact stops the car dead, and with the throttle
    // still held the car never gets beyond the wall (it may drive off along it).
    await page.keyboard.down('d')
    const deadline = Date.now() + 25000
    while (!(await latest(page)).contacts && Date.now() < deadline) await sleep(200)
    await page.keyboard.up('d')
    assert((await latest(page)).contacts > 0, `${track}: no wall contact`)
    await sleep(2500)
    const after = await page.evaluate(() => {
      const firstHit = window.__ticks.findIndex(([, , , contacts]) => contacts > 0)
      return { hitSpeed: window.__ticks[firstHit][2], clearances: window.__ticks.slice(firstHit).map((tick) => tick[4]) }
    })
    assert.equal(after.hitSpeed, 0, `${track}: car did not stop on impact`)
    const deepest = Math.min(...after.clearances)
    const limit = -(BARRIER_OFFSET[track] + CAR_HALF_WIDTH + 0.1)
    assert(deepest > limit, `${track}: car centre ${(-deepest).toFixed(2)} m past the edge, beyond the wall at ${BARRIER_OFFSET[track]} m`)
    await page.keyboard.up('w')

    assert.deepEqual(errors, [], `${track}: page errors`)
    await page.screenshot({ path: `e2e/shots/smoke-${track.toLowerCase().replaceAll(' ', '-')}.png` })
    console.log(`PASS ${track}: real-time simulation (${ratio.toFixed(3)}x), wall stops the car`)
    await page.close()
  }
} finally {
  await browser.close()
}
