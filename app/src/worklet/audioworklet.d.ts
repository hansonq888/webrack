// Globals of AudioWorkletGlobalScope, which TypeScript's DOM lib doesn't include.

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

declare const sampleRate: number
declare const currentFrame: number
