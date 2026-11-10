// Graceful degradation (src/engine/load-shedder.ts) on simulated underrun counts.
// Run: node tests/load-shedder.test.ts

import { LoadShedder } from '../src/engine/load-shedder.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`)
  if (!ok) failures++
}

/** Feeds one cumulative underrun count per second; returns [second, cap] at each change. */
function simulate(counts: number[]): [number, number][] {
  const shedder = new LoadShedder()
  const changes: [number, number][] = []
  counts.forEach((total, second) => {
    const cap = shedder.update(total, second * 1000)
    if (cap !== null) changes.push([second, cap])
  })
  return changes
}

const flat = (n: number, value: number) => Array<number>(n).fill(value)

{
  const changes = simulate(flat(120, 0))
  check('clean output never sheds', changes.length === 0, JSON.stringify(changes))
}
{
  // An isolated glitch now and then is noise, not overload.
  const counts = Array.from({ length: 120 }, (_, s) => Math.floor(s / 20))
  const changes = simulate(counts)
  check('isolated glitches do not shed', changes.length === 0, JSON.stringify(changes))
}
{
  // Two glitches in quick succession: overloaded.
  const changes = simulate([0, 0, 1, 2, ...flat(5, 2)])
  check('clustered glitches shed to 8 voices', changes.length === 1 && changes[0][1] === 8, JSON.stringify(changes))
}
{
  // Sustained glitching steps down once per window, not straight to the floor.
  const counts = Array.from({ length: 20 }, (_, s) => s * 2)
  const changes = simulate(counts)
  const caps = changes.map(([, cap]) => cap)
  check('sustained glitching steps 16 -> 8 -> 4 and stops at the floor', caps.join() === '8,4', JSON.stringify(changes))
  check('steps are at least 5 s apart', changes.length === 2 && changes[1][0] - changes[0][0] >= 5, JSON.stringify(changes))
}
{
  // Overload, then clean: restore one step per 30 s of clean output.
  const counts = [0, 2, 4, 6, 8, 10, 12, 14, ...flat(100, 14)]
  const changes = simulate(counts)
  const caps = changes.map(([, cap]) => cap)
  check('recovers 4 -> 8 -> 16 after clean output', caps.join() === '8,4,8,16', JSON.stringify(changes))
  const recoveries = changes.slice(2)
  check('each recovery waits 30 s', recoveries.every(([s], i) => s - (i === 0 ? changes[1][0] : recoveries[i - 1][0]) >= 30), JSON.stringify(changes))
}
{
  // A counter that starts high (the context has been running) isn't a burst.
  const changes = simulate([500, 500, 500, 500])
  check('an existing count at start is not counted as new glitches', changes.length === 0, JSON.stringify(changes))
}

if (failures) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all passed')
