# WebRack: plan & requirements

Sep 29, 2026 · @Hanson · revision 3

WebRack turns your voice into a beat, gives it the slowed + reverb treatment, and hands you a file you can post, all in the browser, with no install and no signup, on a custom C++20/WebAssembly audio engine. Version 1 ships at webrack.hansonqin.com by **Oct 15, 2026**, in 23 hours of evening work.

---

## 1. The product

### The pitch

**Record a few sounds with your mouth. Tap out a beat. Slow it down, drown it in reverb, and post it.**

The core loop takes under two minutes on a phone:

```
record  →  sequence  →  vibe (slow + reverb)  →  export / share
(pads)     (16 steps)    (one master chain)       (WAV now, MP4 next)
```

### Why this shape (what changed from revision 2)

Research (Sep 29) found that **both halves are already crowded**. Free, no-signup tools that process audio locally exist for each:

- Slowed + reverb: slowedgenerator.com (WAV/MP3/MP4, pitch control, bass boost), audiowrench, slowedandreverb.io, and others
- Voice pads: bap.studio (16 pads, sequencer, share links), soundtools.io beat maker (mic onto pads, 3 s limit, touch-friendly)

"Free, local, no signup" is table stakes. What nobody does:

1. **Voice sampler + slowed + reverb in one flow.** Every slowed + reverb tool needs you to already have a song, and every beat maker ends at a dry loop. WebRack's hook is slowing and reverbing *your own voice beat*.
2. **A good experience on phones.** The most complete pad tools are desktop-first, BandLab needs an account, and Koala needs an app install.
3. **A post-ready video.** TikTok and Reels don't take audio-only uploads, and almost no tool exports an MP4.
4. **Published engineering numbers.** No competitor publishes latency or timing figures.

So WebRack is no longer "two modes." It's **one app: a source feeding one master "vibe" chain**:

- **Source:** your pads and sequencer (the main path), or a song file you drop in (secondary; it comes almost free because it shares the chain)
- **Vibe:** speed 0.5×–1.0× (tape-style: pitch drops with tempo), reverb, EQ
- **Out:** WAV export, shared through the phone's share sheet; MP4 is the first stretch goal

### Who it's for (version 1)

| User | Device | What they do | Priority |
|---|---|---|---|
| Friends making voice beats | **Phone**, after tapping a link in a group chat | record → beat → vibe → send | Primary |
| Slowed + reverb makers | Laptop | drop a song → vibe → export | Secondary |
| Recruiters / engineers | Laptop | open the link, read the README numbers | Showcase |

Deferred: Wind Ensemble musicians (practicing along needs pitch-preserving time-stretch, so version 2) and studio clients (they'd want LUFS metering, a stretch goal).

### Design principles

- **The sequencer is the main interaction on phones, not live finger drumming.** Phone output latency when the mic is active can be very large (one report measured about 188 ms round trip on an iPhone 16), and no engine can fix that. A step sequencer doesn't care about latency. Live play by keyboard on desktop is where the latency story lives.
- **The first tap makes sound.** The Start screen unlocks audio (which iOS requires), and a demo kit with a demo pattern is preloaded, so the second tap plays a beat.
- **Never lose work.** Recordings and the pattern persist on the device.
- **Your voice never leaves your device.** No server, no uploads. Say it in the UI; it's a feature.

---

## 2. Architecture

```
 UI thread (TypeScript)                 AudioWorklet (C++ → WASM)
 ─────────────────────                  ─────────────────────────
 pads, sequencer grid, knobs ──SPSC──▶  event queue → voices (16, stealing)
                                         sequencer (counts samples)
 meters, status          ◀──SPSC───     speed → EQ → reverb → out
```

The UI never touches audio directly. The C++ audio thread never blocks and never allocates. Events apply at the start of the next 128-sample block (2.67 ms at 48 kHz), and sequencer hits land on exact sample positions within a block.

### Engineering decisions (locked, with reasons)

| Decision | Why |
|---|---|
| Build a **standalone `.wasm` with no JS glue** (`-sSTANDALONE_WASM --no-entry`, zero imports) and instantiate it directly in the worklet with `new WebAssembly.Instance(module, {})`; **not** `-sAUDIO_WORKLET` | `-sAUDIO_WORKLET` requires `-sWASM_WORKERS` and shared memory. The standalone module is 7 KB, has a plain C ABI (`wr_*`), and the same C++ builds natively for the harness. The main thread compiles it on page load and passes the `WebAssembly.Module` via `processorOptions` (Safari 16+, WebKit bug 220038). |
| **Fixed** `INITIAL_MEMORY`, no growth | Growing shared memory leaves JavaScript views at the old length. Size it for about 10 minutes of stereo int16 song plus the pad samples. |
| SharedArrayBuffer SPSC queues; COOP/COEP on Vercel | Supported in Safari/iOS 15.2+, Chrome, and Firefox 79+ when the page is cross-origin isolated. Check `crossOriginIsolated` at startup and show a clear error if it's false. |
| Speed = voice playback rate × sequencer tempo (tape model) | For the beat, "slowed" means every voice plays at rate r and the tempo scales by r, with no master resampler needed. For a song, it's the song's playback rate (cubic or windowed-sinc interpolation). Reverb comes after speed, so the tail isn't slowed, which is the right sound. |
| iOS audio session: `navigator.audioSession.type = "playback"`, switched to `"play-and-record"` only while recording | The Web Audio default is "ambient," which the silent switch mutes. Recording forces play-and-record, which can drop output to the earpiece at low volume, so switch back as soon as recording ends. Feature-detect, because only Safari has it. |
| Mic constraints `{echoCancellation:false, noiseSuppression:false, autoGainControl:false}` | Voice-processing filters wreck beatbox sounds. Check `getSupportedConstraints()`, because Safari may not honor all three. |
| **Performance numbers come from a benchmark, not from inside the worklet** | `performance` isn't exposed in `AudioWorkletGlobalScope` (spec issue 2413 is open). Run the *same* `.wasm` in a Web Worker, processing blocks back to back and timed with `performance.now()` (5 µs resolution in Chrome when cross-origin isolated), plus a native build for the soak test and the offline-render timing checks. |

---

## 3. Functional requirements

| ID | Requirement | Priority | Acceptance test |
|---|---|---|---|
| FR1 | 16 pads: tap (phone), click, or keys 1–4 / Q–R / A–F / Z–V | V1 must | Every pad triggers; holding a key doesn't retrigger |
| FR2 | Start screen unlocks audio; demo kit + demo pattern preloaded | V1 must | Beat plays within 3 s of tapping Start, including on iPhone with the silent switch on |
| FR3 | Record the mic onto the selected pad, auto-trimmed, up to 4 s | V1 must | A 2 s recording plays back without leading silence, on desktop and iPhone, at normal speaker volume afterwards |
| FR4 | Pick or drop an audio file (WAV, MP3, FLAC) onto a pad | V1 must | The file plays on that pad |
| FR5 | 16-voice polyphony with oldest-voice stealing | V1 must | 16 hits with no dropout; a 17th replaces the oldest |
| FR6 | 16-step sequencer, 60–180 BPM, play/stop, usable at 375 px width | V1 must | Every hit lands on the exact sample in an offline render |
| FR7 | Vibe: speed 0.5×–1.0× on the whole mix (tape-style) | V1 must | At 0.8× the beat plays at 80% tempo with pitch down about 3.9 semitones; no clicks while sweeping |
| FR8 | Vibe: reverb (size, damping, pre-delay, mix) | V1 must | Mix at 0% is identical to bypass |
| FR9 | Vibe: 3-band EQ (low shelf, mid peak, high shelf) | V1 must | Each band audible when swept; no clicks |
| FR10 | Export WAV (pattern × N loops + reverb tail, or the full song) and share it through Web Share (download fallback) | V1 must | The export matches live playback, and it opens the share sheet on iPhone and Android |
| FR11 | Song as a source: drop in a song; the same vibe chain and export apply | V1 must (cut last) | A 3-minute MP3 slows to 0.8× and exports |
| FR12 | Save the kit and pattern on the device (IndexedDB) | V1 must | Recordings and the pattern survive a reload |
| FR13 | Cookie-free visit counting (Vercel Web Analytics) | V1 must | Dashboard shows visits (the Hobby plan allows 50k events/month, enough) |
| FR14 | **Export an MP4** (9:16 still card + audio) for TikTok/Reels | V1 stretch #1 | The file uploads to TikTok and Instagram from a phone. WebCodecs + mediabunny; AAC where `isConfigSupported` allows it (Chrome, most Safari 26+), otherwise hide the button |
| FR15 | Benchmark page `/bench`: runs the engine in a Worker and shows p50 / p99 / worst block time | V1 stretch #2 | Numbers match the native harness within 2× |
| FR16 | Level meters | V1 stretch #3 | Meters follow the audio |
| — | Bass boost preset, swing, per-pad volume | V2 | — |
| — | Pitch-preserving time-stretch (phase vocoder); melodic mode (a pad played across the keyboard) | V2 | 0.8× keeps the key; a voice stays recognizable across an octave |
| — | Remixable kit links (pattern + settings in the URL; audio can't travel in a URL) | V2 | Opening a link restores everything except recordings |
| — | Auto-slice a beatbox take onto pads (onset detection) | V2 | Each distinct hit lands on its own pad |
| — | Compressor, tape saturation with oversampling; convolution reverb (partitioned FFT) | V2 | — |

Cut from the plan: the fallback without SharedArrayBuffer (every target browser supports SharedArrayBuffer when the page is cross-origin isolated) and the live in-worklet performance panel (the worklet can't time itself; FR15 replaces it).

**Out of scope:** accounts, a server, uploading user audio, and importing from YouTube or streaming services. Users process only their own files, locally.

---

## 4. Performance targets

Every number in the README and on the resume is measured. The machine and browser are named next to each one.

| Metric | Target | How it's measured |
|---|---|---|
| Block time, full chain (16 voices + speed + EQ + reverb) | p99 < 1.33 ms (50% of the 2.67 ms budget) | Worker benchmark (FR15) in Chrome on your Mac, plus the native harness |
| Worst block over a 10-minute soak | < 2.67 ms | Native harness, 10 minutes of audio rendered in real-time-sized blocks |
| Sequencer jitter | 0 samples | Offline render; assert every hit's sample index |
| Audio-thread allocations | 0 | Allocation counter in a debug build (override `operator new`) |
| Engine latency | ≤ 1 block (2.67 ms) from event to output | By design; confirmed by an offline test |
| End-to-end latency from key to sound | Report it, don't promise it | `baseLatency` + `outputLatency` (Safari 18.4+ has `outputLatency`), plus Superpowered's browser latency test on wired output |
| Export | A 3-minute song with speed + reverb in < 10 s | Wall-clock time of the offline render |
| Download size | < 2 MB of WASM + JS (gzipped), excluding the demo kit | Build output |
| Devices | Chrome, Safari, Firefox desktop; **iOS Safari 17+ and Android Chrome, fully usable** | Manual checklist before release (§7) |

---

## 5. Build plan

23 hours over 16 days: 1 hour on weekdays, 3 on weekend days. Classes and daily LeetCode come first. Friday Oct 9 is the buffer.

### Status, Sep 29 (night 0)

Built ahead of schedule: the whole version 1 feature set except MP4 and the `/bench` page. **Not yet verified on a real phone or with a real mic** (the browser pane can't).

| Area | State |
|---|---|
| Engine (C++): 16-voice sampler + stealing, sample-accurate sequencer, tape speed, 3-band EQ, Freeverb (input HP + pre-delay), song player, soft clip | Done; native tests pass |
| SPSC command ring (SharedArrayBuffer) + status block; port-message fallback without SharedArrayBuffer | Done |
| Pads (tap / click / keys), steps, BPM, play/stop, demo kit (synthesized, 16 sounds) + demo pattern | Done; verified in Chrome |
| Mic recording with auto-trim, iOS audio-session switching | Built; **needs a real mic + iPhone test** |
| Load a file onto a pad (click or drag), reset to kit | Done; verified |
| Song mode: load, varispeed, seek | Done; verified with a generated 3-minute WAV |
| Export WAV via OfflineAudioContext (same processor), Web Share + download | Done; share **needs a phone test** (not offered in desktop Chrome) |
| Save kit, pattern, vibe to IndexedDB | Done; verified across reload |
| Hardware UI (putty body, rubber pads, violet LCD, console knobs) | Done; phone and desktop layouts checked |

**Measured so far** (MacBook, Apple M5 Pro; Chrome; Node 22 / V8 12.4):

| Metric | Result |
|---|---|
| Worst-case full chain, native, 10-minute soak | p50 7.8 µs · p99 13.1 µs (0.5% of budget) · max 158 µs · 0 blocks over budget |
| Same, **`engine.wasm` in V8** | p50 11.8 µs · p99 20.7 µs (0.8%) · max 516 µs (19%) · 0 over |
| Sequencer jitter (9 tempo × speed combinations) | 0 samples |
| Allocations in `process()` | 0 |
| Reverb mix 0 vs. dry | bit-identical |
| Export, 3-minute song, slowed 0.8× + reverb | 0.79 s (render 0.64 s), target < 10 s |
| Export, 4 loops of the demo beat | ~0.06 s |
| Download (gzipped): JS 11 KB + CSS 4.5 KB + worklet 3 KB + wasm 17.7 KB | ~36 KB, plus ~100 KB of fonts |
| Demo mix levels | dry peak -2.5 dBFS; slowed + reverb peak -2.2 dBFS; no clipping |

### JS vs WASM benchmark (Sep 29)

`npm run bench -- 10` in `app/`. The same engine, ported line by line to TypeScript (`app/src/bench/js-engine.ts`: typed arrays, zero allocations in `process()`), on the same worst-case scenario and identical inputs. Outputs agree to 76 dB below the signal, so both do the same work. Each engine starts cold (JIT warm-up included). Node 22 / V8 12.4, Apple M5 Pro, 10 minutes of audio, 3 runs (raw JSON in `docs/bench/`):

| | p50 | p99 | p99.9 | throughput |
|---|---|---|---|---|
| C++ → WASM | 11.1–11.4 µs | 19–45 µs | 39–121 µs | 210–233× real time |
| JavaScript | 19.2–19.3 µs | 33–64 µs | 87–154 µs | 126–134× real time |
| **WASM advantage** | **1.7× (every run)** | 1.4–1.9× | 1.3–2.7× | **1.7–1.8×** |

What this shows, honestly:
- **The stable result is 1.7× faster** (median and throughput). The tails favor WASM in every run but are noisy (OS scheduling on a laptop), and single-run max values are noise.
- **Both are far under budget on this machine.** JavaScript would also be fine on an M5 for this workload. WASM's case rests on slower phones, heavier DSP (convolution, phase vocoder), and consistency.
- **`-msimd128` autovectorization gains nothing** (1.6×): the loops have bounds checks and feedback dependencies. Real SIMD needs hand restructuring (8 combs or 4 voices per vector), which is the November SIMD project.
- Next: run the same comparison in Chrome, Safari (JavaScriptCore) and Firefox (SpiderMonkey) via a `/bench` page, and on a phone, where the gap may differ.

**Cut order if behind:** meters → the `/bench` page (keep the native harness) → MP4 → song as a source. **Never cut:** phone support, export + share, saving on the device, the native harness.

### Week 1: sound out of C++, on a phone
- [x] **Wed Sep 30 (1 h):** git repo, Vite + TypeScript, install Emscripten; hello-world C++ → WASM built for the worklet environment with fixed memory *(done Sep 29)*
- [x] **Thu Oct 1 (1 h):** worklet instantiates the WASM and plays a C++ sine; Start button; `audioSession.type = "playback"` *(done Sep 29)*
- [ ] **iPhone check with the silent switch on**, moved to Fri: AudioWorklet needs a secure context, so a phone can't test over plain-HTTP LAN; it needs the HTTPS deploy
- [ ] **Fri Oct 2 (1 h):** Vercel deploy with COOP/COEP, `crossOriginIsolated` check, domain, Vercel Analytics; confirm the analytics script loads with COEP on
- [ ] **Sat Oct 3 (3 h):** decode samples into WASM memory; 16-voice engine with stealing; tappable 4×4 pad grid + keyboard map; CC0 demo kit
- [ ] **Sun Oct 4 (3 h):** SPSC queues; mic recording with auto-trim, turning voice-processing filters off, iOS session switch and back; native harness skeleton (offline render + block timing)

### Week 2: a beat you can send
- [ ] **Mon Oct 5 (1 h):** 3-band EQ (RBJ cookbook biquads, smoothed coefficients)
- [ ] **Tue Oct 6 (1 h):** sequencer in the engine, sample-accurate; demo pattern; jitter test in the harness
- [ ] **Wed Oct 7 (1 h):** sequencer UI (one pad row at a time on phones, full grid on desktop), BPM, play/stop
- [ ] **Thu Oct 8 (1 h):** WAV export by offline render + Web Share with a download fallback. **Milestone: record → beat → send works on a phone.**
- [ ] **Fri Oct 9:** buffer
- [ ] **Sat Oct 10 (3 h):** reverb (2 h); speed control, tape model (30 min); song as a source through the same chain and export (30 min)
- [ ] **Sun Oct 11 (3 h):** save to the device with IndexedDB (1 h); soak test, allocation check, export timing in the harness (1 h); MP4 export spike, finished only if it's going well (1 h)

### Ship it
- [ ] **Mon Oct 12 (1 h):** run the device checklist (§7); fix blockers
- [ ] **Tue Oct 13 (1 h):** README with a demo GIF, the architecture diagram and measured numbers
- [ ] **Wed Oct 14 (1 h):** send to 5 friends and the studio; **watch 2 people use it on their phones without help** and write down where they get stuck
- [ ] **Thu Oct 15 (1 h):** fix the worst sticking point; record final metrics; update the resume

---

## 6. Version 2 (November), ordered by value per hour

1. MP4 export, if it didn't make version 1; bass boost; swing
2. JavaScript vs. WASM benchmark of the same kernel (the proof behind choosing C++)
3. Phase vocoder → pitch-preserving slow-down + melodic mode (15–25 h; unlocks Wind Ensemble practice)
4. Remixable kit links
5. Beatbox auto-slicing (onset detection)
6. Convolution reverb with partitioned FFTs and a campus room's impulse response
7. WASM SIMD pass with before-and-after numbers
8. Compressor + tape saturation with oversampling

Stretch goals: a daily "match the sound" game, LUFS metering for studio clients, the engine on a Daisy Seed pedal.

---

## 7. Device checklist (run before release)

- [ ] iPhone, Safari: silent switch **on**, Start → demo beat is audible
- [ ] iPhone: record a pad → playback volume is normal afterwards (not earpiece-quiet)
- [ ] iPhone: export → share sheet → send via iMessage → it plays on the receiving end
- [ ] iPhone: drop an MP3 and a FLAC song (FLAC through `decodeAudioData` on iOS is unverified)
- [ ] Android Chrome: same four checks
- [ ] Desktop Chrome / Safari / Firefox: keyboard play, sequencer, export, song source
- [ ] Reload after recording → kit is still there
- [ ] `crossOriginIsolated === true` on the production domain

---

## 8. Resume bullet

**WebRack** — C++20, WebAssembly, TypeScript, Web Audio · webrack.hansonqin.com
- Built a zero-install browser voice sampler and slowed + reverb tool on a custom C++20/WebAssembly audio engine, processing 16 voices plus speed, EQ and reverb in **X** ms p99 per 128-sample block (**Y**% of the 2.67 ms real-time deadline).
- Designed a real-time-safe audio thread with lock-free SPSC queues and zero allocations, with sample-accurate sequencing verified by offline render.
- Shipped to desktop and mobile browsers; **N** people used it in its first week; exports a 3-minute slowed + reverb song in **W** s.

Metrics to record by Oct 15: p50/p99/worst block time (with machine and browser), soak result, export time, visitors.
Layout: add Projects above Leadership; cut Shown Space from five bullets to four.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Emscripten + worklet setup eats days | Week 1 slips | Manual instantiation route, decided on day 1; timebox 5 h, then ask for help |
| iOS audio quirks (silent switch, earpiece routing after recording, 44.1 vs 48 kHz distortion) | The main audience gets a broken first impression | iPhone test from Oct 1; audio session handling in FR2/FR3; create the AudioContext without forcing a sample rate |
| Phone latency makes live pads feel bad | Pads feel laggy | Sequencer-first on phones; don't market live play on mobile |
| Crowded market | Nobody cares | Lead with the combined flow ("slow + reverb your own voice beat") and the post-ready export |
| Classes and recruiting | Plan slips | Oct 9 buffer; cut order in §5 |
| Scope creep (MP4, phase vocoder) | Version 1 never ships | MP4 is a spike on Oct 11 only; the phase vocoder is version 2 only |

## 10. Open questions

- [x] Demo kit: **CC0 for version 1**; record a studio kit for version 2 (with the musicians' OK)
- [x] Analytics in version 1: **yes** (FR13), because the resume needs N
- [ ] Name: WebRack reads as a rack of plugins, not "voice beat → slowed + reverb." Decide before Oct 14's share. This one is yours.
