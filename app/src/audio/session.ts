// iOS Safari's audio session. Web Audio defaults to "ambient", which the
// silent switch mutes, so the app runs as "playback" and switches to
// "play-and-record" only while the mic is open (recording forces that mode and
// can route output to the quiet earpiece, so we switch back right after).
// Only Safari implements navigator.audioSession; elsewhere this is a no-op.

type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record'

export function setAudioSession(type: AudioSessionType): void {
  const session = (navigator as Navigator & { audioSession?: { type: AudioSessionType } }).audioSession
  if (session) session.type = type
}
