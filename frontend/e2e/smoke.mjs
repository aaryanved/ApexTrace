// End-to-end check of the built game in real Chrome: no server besides the page.
//   Run: npm run build && npx vite preview --port 4173, then node e2e/smoke.mjs
//   (BASE=... to point elsewhere, e.g. the deployed site)
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://localhost:4173'
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
            for (const m of e.data.messages) if (m.type === 'vehicle_state') window.__ticks.push([performance.now() / 1000, m.t, m.speed, m.barrier_contacts])
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

    await page.keyboard.down('w')
    const throttleFrom = (await latest(page)).t
    await sleep(4500)
    // (Baku's first corner is ~220 m away, so full throttle may meet its wall first)
    const peak = await page.evaluate((from) => Math.max(...window.__ticks.filter(([, t]) => t >= from).map(([, , v]) => v)), throttleFrom)
    assert(peak * 3.6 > 120, `${track}: only ${Math.round(peak * 3.6)} km/h under full throttle`)

    // Steer into the wall: the car stops, and held throttle can't push it through.
    await page.keyboard.down('d')
    const deadline = Date.now() + 25000
    while (!(await latest(page)).contacts && Date.now() < deadline) await sleep(200)
    await page.keyboard.up('d')
    assert((await latest(page)).contacts > 0, `${track}: no wall contact`)
    await sleep(1500) // settle against the wall, then a second of held throttle
    const settled = (await latest(page)).t
    await sleep(1000)
    const pushed = await page.evaluate((from) => Math.max(...window.__ticks.filter(([, t]) => t > from).map(([, , v]) => v)), settled)
    assert(pushed * 3.6 < 1, `${track}: throttle pushed through the wall (${(pushed * 3.6).toFixed(1)} km/h)`)
    await page.keyboard.up('w')

    assert.deepEqual(errors, [], `${track}: page errors`)
    await page.screenshot({ path: `e2e/shots/smoke-${track.toLowerCase().replaceAll(' ', '-')}.png` })
    console.log(`PASS ${track}: real-time simulation (${ratio.toFixed(3)}x), wall stops the car`)
    await page.close()
  }
} finally {
  await browser.close()
}
