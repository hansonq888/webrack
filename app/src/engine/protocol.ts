// Shared between the UI thread and the engine worklet.

// Commands carried by the SPSC ring (or port messages when there's no
// SharedArrayBuffer, and always for offline export renders).
export const Op = {
  Trigger: 1, // a = pad, f = gain
  SetStep: 2, // a = pad, b = step, f = on (0/1)
  ClearPattern: 3,
  Bpm: 4, // f
  Playing: 5, // a = 0/1
  Speed: 6, // f
  EqGain: 7, // a = band, f = dB
  Reverb: 8, // a = ReverbParam, f
  SongPlaying: 9, // a = 0/1
  SongSeek: 10, // a = frame
  MasterGain: 11, // f
  StopAfterSteps: 12, // a = steps (export: play exactly N loops)
  PatternLength: 13, // a = 16, 32 or 64
} as const

export const ReverbParam = { Size: 0, Damping: 1, PreDelayMs: 2, Mix: 3 } as const

export type Command = [op: number, a: number, b: number, f: number]

// Engine status snapshot, mirrored from the C++ Status struct (8 x 32-bit).
export const StatusIndex = {
  Step: 0,
  SeqPlaying: 1,
  PeakLeft: 2, // float
  PeakRight: 3, // float
  SongFrame: 4,
  SongLength: 5,
  SongPlaying: 6,
  Voices: 7,
  Blocks: 8, // written by the worklet: blocks rendered so far
} as const
export const STATUS_WORDS = 9

// Bulk data and control messages over the worklet's MessagePort.
export type PortMessage =
  | { type: 'commands'; commands: Command[]; id?: number }
  | { type: 'pad'; pad: number; data: Float32Array | null; id?: number }
  | { type: 'song-begin'; id?: number }
  | { type: 'song-chunk'; offset: number; data: Int16Array; id?: number }
  | { type: 'song-commit'; frames: number; id?: number }

export type ProcessorReply =
  | { type: 'ready'; padCapacity: number; songCapacity: number }
  | { type: 'ack'; id: number }
  | { type: 'status'; status: ArrayBuffer }

// Full engine state handed to an offline (export) processor up front, so the
// render needs no round trips before startRendering().
export interface InitialState {
  pads: (Float32Array | null)[]
  song: Int16Array | null
  commands: Command[]
}

export interface ProcessorOptions {
  module: WebAssembly.Module
  ring: SharedArrayBuffer | null
  status: SharedArrayBuffer | null
  initial?: InitialState
}
