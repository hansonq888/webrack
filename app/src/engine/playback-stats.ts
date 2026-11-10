// The browser's own view of output health. Chrome's AudioContext.playbackStats
// counts underruns: times the audio device needed samples and none were ready,
// which is an audible glitch. Other browsers don't expose it yet, so callers
// get null there.

export interface PlaybackStats {
  underrunEvents: number
  /** Seconds of output that were underruns. */
  underrunDuration: number
  /** Seconds of output played. */
  totalDuration: number
}

export function readPlaybackStats(context: AudioContext): PlaybackStats | null {
  const stats = (context as AudioContext & { playbackStats?: PlaybackStats }).playbackStats
  if (!stats) return null
  return {
    underrunEvents: stats.underrunEvents,
    underrunDuration: stats.underrunDuration,
    totalDuration: stats.totalDuration,
  }
}
