// A CPU hog for contention tests: spins on one core until the shared stop
// flag is set. Several of these run alongside the audio thread to see how the
// engine holds up when the machine is busy.

onmessage = ({ data: stop }: MessageEvent<SharedArrayBuffer>) => {
  const flag = new Int32Array(stop)
  let sink = 0
  while (Atomics.load(flag, 0) === 0) sink = (sink + 1) | 0
  postMessage(sink)
}
