// The demo kit, synthesized at startup: nothing to download, nothing to
// license. A lo-fi set in C minor so the demo pattern sounds like a beat,
// not a test: drums, four 808 notes, and four electric-piano chords.

import { normalize } from './trim'

export interface KitSound {
  name: string
  render(sampleRate: number): Float32Array
}

// Scales a normalized (peak -1 dBFS) sound to a mix level.
const level = (gain: number, render: (sr: number) => Float32Array) => (sr: number) => {
  const out = render(sr)
  for (let i = 0; i < out.length; i++) out[i] *= gain
  return out
}

const TAU = Math.PI * 2
const midi = (note: number) => 440 * 2 ** ((note - 69) / 12)

function synth(sampleRate: number, seconds: number, fn: (t: number, i: number) => number): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = fn(i / sampleRate, i)
  return normalize(out)
}

// Deterministic noise, so the kit is identical on every load.
function noiseSource(seed = 1) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
}

// RBJ biquad for shaping noise.
function biquad(type: 'bandpass' | 'highpass', sampleRate: number, freq: number, q: number) {
  const w0 = (TAU * freq) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cw = Math.cos(w0)
  const [b0, b1, b2] = type === 'bandpass' ? [alpha, 0, -alpha] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
  const a0 = 1 + alpha
  const a1 = -2 * cw
  const a2 = 1 - alpha
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  return (x: number) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x; y2 = y1; y1 = y
    return y
  }
}

const decay = (t: number, time: number) => Math.exp(-t / time)
const attack = (t: number, time: number) => 1 - Math.exp(-t / time)

function kick(sr: number) {
  const noise = noiseSource(2)
  let phase = 0
  return synth(sr, 0.6, (t) => {
    phase += (TAU * (45 + 110 * decay(t, 0.03))) / sr
    const body = Math.sin(phase) * decay(t, 0.25)
    return Math.tanh(1.6 * (body + noise() * 0.25 * decay(t, 0.002)))
  })
}

function snare(sr: number) {
  const noise = noiseSource(3)
  const bp = biquad('bandpass', sr, 3000, 0.7)
  return synth(sr, 0.35, (t) => {
    const tone = Math.sin(TAU * 185 * t) * decay(t, 0.05) * 0.5 + Math.sin(TAU * 330 * t) * decay(t, 0.03) * 0.3
    return tone + bp(noise()) * 1.4 * decay(t, 0.12)
  })
}

function clap(sr: number) {
  const noise = noiseSource(4)
  const bp = biquad('bandpass', sr, 1100, 1.5)
  return synth(sr, 0.4, (t) => {
    let env = 0
    for (const at of [0, 0.011, 0.022]) if (t >= at) env = Math.max(env, decay(t - at, 0.004))
    if (t >= 0.03) env = Math.max(env, 0.8 * decay(t - 0.03, 0.09))
    return bp(noise()) * env
  })
}

function hat(sr: number, time: number, seconds: number, seed: number) {
  const noise = noiseSource(seed)
  const hp = biquad('highpass', sr, 7000, 0.7)
  return synth(sr, seconds, (t) => hp(noise()) * decay(t, time))
}

function rim(sr: number) {
  return synth(sr, 0.08, (t) => Math.sin(TAU * 1700 * t) * decay(t, 0.006) + 0.6 * Math.sin(TAU * 480 * t) * decay(t, 0.02))
}

function shaker(sr: number) {
  const noise = noiseSource(6)
  const hp = biquad('highpass', sr, 5000, 0.7)
  return synth(sr, 0.22, (t) => hp(noise()) * attack(t, 0.012) * decay(t, 0.06))
}

function bell(sr: number) {
  const bp = biquad('bandpass', sr, 900, 2)
  const square = (f: number, t: number) => (Math.sin(TAU * f * t) >= 0 ? 1 : -1)
  return synth(sr, 0.35, (t) => bp(square(562, t) + square(845, t)) * decay(t, 0.08))
}

function bass808(sr: number, note: number) {
  const f0 = midi(note)
  let phase = 0
  return synth(sr, 1.6, (t) => {
    phase += (TAU * f0 * (1 + 1.5 * decay(t, 0.02))) / sr
    return Math.tanh(2 * Math.sin(phase) * attack(t, 0.002) * decay(t, 0.9))
  })
}

// Two-operator FM electric piano, a little detuned and with slow tremolo.
function chord(sr: number, notes: number[]) {
  return synth(sr, 2.4, (t) => {
    let sum = 0
    notes.forEach((note, n) => {
      const f = midi(note) * (1 + (n % 2 ? 0.0015 : -0.0015))
      const index = 2.2 * decay(t, 0.25) + 0.3
      sum += Math.sin(TAU * f * t + index * Math.sin(TAU * f * t))
    })
    const tremolo = 1 + 0.12 * Math.sin(TAU * 4.5 * t)
    return (sum / notes.length) * attack(t, 0.003) * decay(t, 1.2) * tremolo
  })
}

// Pad order matches the 4x4 grid and keys 1-4 / Q-R / A-F / Z-V.
export const DEMO_KIT: KitSound[] = [
  { name: 'Kick', render: level(0.85, kick) },
  { name: 'Snare', render: level(0.7, snare) },
  { name: 'Clap', render: level(0.6, clap) },
  { name: 'Hat', render: level(0.35, (sr) => hat(sr, 0.03, 0.15, 5)) },
  { name: 'Open hat', render: level(0.3, (sr) => hat(sr, 0.25, 0.6, 7)) },
  { name: 'Rim', render: level(0.45, rim) },
  { name: 'Shaker', render: level(0.35, shaker) },
  { name: 'Bell', render: level(0.4, bell) },
  { name: '808 C', render: level(0.55, (sr) => bass808(sr, 36)) },
  { name: '808 E♭', render: level(0.55, (sr) => bass808(sr, 39)) },
  { name: '808 F', render: level(0.55, (sr) => bass808(sr, 41)) },
  { name: '808 A♭', render: level(0.55, (sr) => bass808(sr, 32)) },
  { name: 'Cm9', render: level(0.4, (sr) => chord(sr, [48, 51, 55, 58, 62])) },
  { name: 'A♭maj7', render: level(0.4, (sr) => chord(sr, [44, 51, 55, 60])) },
  { name: 'Fm9', render: level(0.4, (sr) => chord(sr, [53, 56, 60, 63, 67])) },
  { name: 'Gm7', render: level(0.4, (sr) => chord(sr, [43, 50, 53, 58])) },
]

// One bar at 86 BPM: pad index → steps.
export const DEMO_PATTERN: Record<number, number[]> = {
  0: [0, 7, 10], // kick
  1: [4, 12], // snare
  3: [0, 2, 4, 6, 8, 10, 12], // hat
  4: [14], // open hat
  5: [15], // rim
  8: [0], // 808 C
  11: [8], // 808 A♭
  12: [0], // Cm9
  13: [8], // A♭maj7
}
export const DEMO_BPM = 86
