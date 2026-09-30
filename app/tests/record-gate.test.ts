// Sound-triggered recording (src/audio/record-gate.ts) on synthetic mic input.
// Run: node tests/record-gate.test.ts

import { DEFAULT_GATE, RecordGate } from '../src/audio/record-gate.ts'

const SR = 48000
const CHUNK = 1024 // what the recorder worklet posts

let seed = 3
const noise = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 2 - 1

/** Feeds [durationMs, amplitude] segments of noise; returns start/stop times in ms. */
function simulate(segments: [number, number][]) {
  const total = segments.reduce((sum, [ms]) => sum + (ms * SR) / 1000, 0)
  const signal = new Float32Array(total)
  let o = 0
  for (const [ms, amp] of segments) for (let i = 0; i < (ms * SR) / 1000; i++) signal[o++] = amp * noise()

  const gate = new RecordGate(SR)
  let start: number | null = null
  let stop: number | null = null
  for (let i = 0; i + CHUNK <= signal.length && gate.state !== 'done'; i += CHUNK) {
    const change = gate.push(signal.subarray(i, i + CHUNK))
    if (change === 'start') start = (i / SR) * 1000
    if (change === 'stop') stop = ((i + CHUNK) / SR) * 1000
  }
  return { start, stop, takeMs: (gate.audio().length / SR) * 1000, state: gate.state }
}

let failures = 0
function check(name: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` → ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
const near = (value: number | null, target: number, tolerance: number) => value !== null && Math.abs(value - target) <= tolerance

const QUIET = 0.001 // -60 dBFS room
const SILENCE = DEFAULT_GATE.silenceMs
const one = simulate([[1000, QUIET], [300, 0.3], [2000, QUIET]])
check('starts when the sound starts', near(one.start, 1000, 25), one)
check(`stops ~${SILENCE} ms after the sound ends`, near(one.stop, 1300 + SILENCE, 50), one)
check('keeps ~150 ms of pre-roll', near(one.takeMs, 150 + 300 + SILENCE, 60), one)

const beatbox = simulate([[500, QUIET], ...Array.from({ length: 6 }, () => [[80, 0.4], [200, QUIET]] as [number, number][]).flat(), [2000, QUIET]])
check('short gaps between hits keep one take going', near(beatbox.stop, 500 + 6 * 280 - 200 + SILENCE, 60), beatbox)

const pause = simulate([[300, QUIET], [200, 0.4], [700, QUIET], [200, 0.4], [2000, QUIET]])
check('a 0.7 s pause mid-phrase keeps recording', near(pause.stop, 300 + 200 + 700 + 200 + SILENCE, 60), pause)

const immediate = simulate([[400, 0.3], [2000, QUIET]])
check('a sound made the instant Rec is tapped triggers', immediate.start === 0, immediate)

const noisyRoom = simulate([[5000, 0.015]])
check('a noisy room alone never triggers', noisyRoom.state === 'armed', noisyRoom)

const noisyThenSound = simulate([[1000, 0.015], [300, 0.4], [1500, 0.015]])
check('a sound still triggers over room noise', near(noisyThenSound.start, 1000, 25), noisyThenSound)

const long = simulate([[300, QUIET], [6000, 0.3]])
check('takes are capped at 4 s', long.state === 'done' && near(long.takeMs, 4000, 1), long)

if (failures) {
  console.log(`${failures} failed`)
  process.exit(1)
}
console.log('all passed')
