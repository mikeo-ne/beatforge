# BEATFORGE

A local web app for beat production: **program beats → export MIDI**, and **turn audio into actual MIDI**.

No accounts, no cloud, no sample packs required. Your own sounds can be loaded locally; nothing is uploaded by the kit. Everything runs locally.

**Two ways to use it:**
- **Download `beatforge.html` and open it.** Both halves work with no install and no server — the step
  sequencer (Web Audio) and the audio→MIDI transcriber, which has a complete JavaScript analyser
  (FFT, band-flux onsets, tempo estimation, drum classification, YIN pitch tracking) built into the page.
- **Run `python3 server.py` and open http://localhost:8000.** The page detects the server and switches to
  the more accurate numpy/scipy analyser automatically. There's an Engine selector if you want to force
  either one.

```
python3 server.py          # from the repo root, then open http://localhost:8000
```

---

## What it does

### 1. Step sequencer → MIDI
- 8 lanes: kick, clap, snare, closed hat, open hat, 808 bass, melody, pad
- Click to place, **Alt**+click to accent, right-click to erase, drag to paint
- **Pitched lanes**: drag a cell up/down to change its note, or use the piano roll (2 octaves, octave switch)
- Live playback with swing control and a per-lane mute — all synthesised in the browser, so it works offline
- **18 genre presets** in four families, each an authentic signature groove rather than a generic loop:

| Family | Genres |
|---|---|
| Hip-hop | Trap 140 · Boom bap 90 · Drill 144 · Lo-fi 85 · Grime 140 · Phonk 130 |
| Club & bass | House 124 · Techno 132 · UK garage 134 · Jersey club 135 · Drum & bass 174 · Dubstep 140 |
| Afro & Caribbean | Afrobeats 106 · Amapiano 112 · Dancehall 100 · Reggaeton 95 |
| Pop & funk | Pop/EDM 128 · Funk/breakbeat 105 |

  Loading a genre sets its tempo, bar count, swing and pattern together. Rhythms are checked by the test
  suite: house is four-on-the-floor with offbeat bass/open hats, reggaeton is a true dembow
  (kick 1 & 3, snare 3/6/11/14), dubstep is half-time with the snare on beat 3, drum & bass is a 2-step
  break with ghost snares, amapiano is a log-drum bass sliding through the scale under a 16th shaker.
- **Randomise** is genre-aware — it keeps the loaded style's feel, drops/adds a few hits, and moves pitches
  within that genre's root and mode (minor / dorian / major / phrygian)
- **Render WAV** → bounces the pattern with `OfflineAudioContext` faster than real time, through the same
  voices and master chain you hear (44.1 kHz 16-bit stereo, normalised to −0.4 dBFS, 2 s tail, ×1/×2/×4/×8
  loops). **MP3** uses WebCodecs (`AudioEncoder`) where the browser ships it — Chrome/Edge yes, Safari
  sometimes not, in which case it says so instead of failing quietly.
- **Export .MID** → Standard MIDI File, type 1, 480 PPQ. Drums go to channel 10 with General MIDI
  note numbers (kick 36, snare 38, clap 39, closed hat 42, open hat 46), so it drops onto a
  Drum Kit Designer track in Logic Pro and lines up immediately. **Logic / DAW MIDI** provides a
  clearly named copy for dragging into Logic Pro, Ableton, FL Studio or Reaper.
- **Kit — your own one-shots** → drop audio onto a track row, kit row or the kit panel, or tap
  **Choose sound** on a phone/tablet. WAV, MP3, M4A, OGG, AIFF and WebM work when the browser can decode
  them. Each lane has its own sample, audition, gain, tuning, pitch-follow, one-shot/gated, reverse,
  trim and timing-shift controls. Loading is additive and does not place or remove grid steps; clear
  a slot to bring that synth voice back. **Clear all** does not clear samples.
- **Humanize performance** → deterministic timing, velocity, length, pitch and expression feel. It uses
  the same seed for every loop and caps timing drift at 45% of one step. Enable **Write feel into MIDI**
  when you want the timing/velocity/length changes exported; otherwise MIDI stays quantised.

### 2. Audio → MIDI
Drop in (or click a demo) a drum loop, bassline, melody or full beat. It returns a multi-track MIDI
file plus an on-screen note timeline, which you can also push straight into the sequencer to edit.

| Stage | Method |
|---|---|
| Onsets | per-band whitened spectral flux (sub / mid / high), averaged over bins so a narrow kick band can't be drowned out by a wide hat band |
| Drum lanes | attack-band decision tree — sub→kick, mid→clap/snare (split by low-body energy), high→hat; open vs closed from a baseline-subtracted decay estimate; coincident hits (kick under hat) are kept as two notes |
| Bass / melody | YIN pitch tracking with loudness-weighted pitch selection, attack gating to reject sustained pads, and segment merging |
| Tempo | comb-filtered autocorrelation → fine period refinement against the onset grid → half/double octave resolution with a musical-tempo prior |
| Grid phase | circular mean of onset phases (robust where a grid-offset scan is not) |

**Controls:** mode (auto / drums / pitched), grid (quarter / 8th / 16th / 32nd), quantise strength,
onset sensitivity, and a manual tempo field with ×2 / ÷2 buttons for half-time material.

---

## Which engine am I using?

| | Server engine (`server.py`) | In-browser engine |
|---|---|---|
| Needs install | numpy + scipy | nothing — pure JS in the HTML |
| Works offline / from a downloaded file | no | **yes** |
| Speed (42 s of audio) | 0.2–1.2 s | 0.9–1.5 s |
| Best for | bass + melody, dense mixes | drums, loops, zero-setup use |

The page tries the server first and silently falls back to the built-in analyser, so audio→MIDI
never breaks just because a server isn't running.

## Measured accuracy

`python3 bench.py` scores the transcriber against a known 140 BPM arrangement (42 s of audio,
bars 1–24). Matching is done in seconds, so the result doesn't depend on which tempo octave was chosen.
The in-browser engine was scored through the same benchmark.

**Server engine**

```
                            recall        precision
Kick lane   / drum bus      55/55  (100%)  100%
Clap lane   / drum bus      23/25  ( 92%)   96%
Hh Closed   / drum bus      155/222 ( 70%)   97%
Melody lane / FULL MIX      49/123 ( 40%)
Bass lane   / FULL MIX      52/88  ( 59%)
melody lane / isolated stem 71/123 ( 58%)
bass lane   / isolated stem 36/88  ( 41%)
tempo error  ±0.0 BPM on the full mix (140.0 detected vs 140.0 true)
```

Drum lanes, before → after the measurement-driven rework:

| lane | before | after |
|---|---|---|
| Kick | 100% recall / 30% spurious | **100% recall / 0% spurious** |
| Clap | 100% recall / 26% spurious | **92% recall / 4% spurious** |
| Closed hat | 61% recall / 31% spurious | **70% recall / 3% spurious** |

Two findings drove that: spectral flux is scale-invariant, so near-silent low-frequency ripple scores as
much flux as a real kick (fixed with an attack test on absolute band energy), and a kick's pitch sweep
crosses several FFT bins and invents onsets, so per-band peak picking is only safe for the high band.

**In-browser engine (same benchmark)**

```
Kick lane  recall  55/55  (100%)  precision 100%
Clap lane  recall  25/25  (100%)  precision 100%
Hh Closed  recall 130/222 ( 59%)  precision  76%
Melody     recall  25/123 ( 20%)
Bass       recall  23/88  ( 26%)
tempo      ±0.0 BPM (140.02 detected vs 140.0 true)
```

**Which to use:** the in-browser engine now matches the server exactly on kick and clap (both 100% recall
and precision), so it's excellent for drum loops and for zero-setup use. Its pitched lanes are much weaker — if you need a
bassline or melody, run the server engine or feed it a stem.

**Straight talk:** drum loops and basslines come back clean — kicks and claps at 100% recall. Melody
recall drops in dense mixes because single-channel transcription cannot fully separate a melody from a
sustaining pad underneath it; that needs source separation. Expect to delete a few notes, and prefer
feeding it stems over full mixes. The octave choice (70 vs 140 BPM) is genuinely ambiguous for
half-time beats — that's what the ×2 / ÷2 buttons and the manual tempo box are for.

---

## Files

| File | What it is |
|---|---|
| `beatforge.html` | the whole app — one self-contained file: sequencer, kit, humanize, renderer and analyser |
| `index.html` | redirects the site root to `beatforge.html` (for GitHub Pages / static hosts) |
| `server.py` | HTTP server + transcription engine (stdlib + numpy/scipy only) |
| `local-engine.js` | source of the in-browser analyser, inlined verbatim into `beatforge.html` |
| `bench.py` | accuracy benchmark against the known arrangement |
| `demo/*.wav` | demo audio (drum loop, melody, 808 bass, full beat) for the one-click demos |
| `tests/` | the suite — `sh tests/run-all.sh` |

### API
```
GET  /                       the app
GET  /api/health             {ok:true}
GET  /demo/<file>            demo audio
POST /api/audio2midi         body: raw little-endian float32 mono PCM
                             query: sr, mode(auto|drums|melody), bpm(auto|number),
                                    sensitivity(0..1), quantize(0..1), grid(4|8|16|32)
                             returns: {bpm, offset, conf, stats, tracks[], midi_b64}
```

## Verification

Run `bash tests/run-all.sh` after installing `npm install` and
`pip install --break-system-packages -r requirements.txt`. The suite covers genre rhythms
(`genre-rhythms.cjs`), all genre exports (`genre-export.cjs`), Logic/DAW MIDI parity
(`midi-parity.cjs`), kit isolation and deterministic humanize (`kit-humanize.cjs`), WAV
rendering (`wav-render.cjs`), MP3/WebCodecs (`mp3-path.cjs`), the browser transcriber
(`browser-engine.cjs`), the real responsive page and sub-path fallback (`dom.cjs`), the
numpy/scipy API and traversal-safe demos (`server-engine.py`), inline analyser integrity
(`check-inline.py`), extraction/syntax (`extract-app.py`), and the optional reference benchmark
(`bench.py`, which correctly skips without its uncommitted reference audio).

---

## Ownership

© 2026 Mike 1ne, Sound Engineer · 7H Music Group. The same attribution is embedded in exported MIDI
conductor metadata. Source code is MIT licensed; see `LICENSE`.

## Notes

- Analysis caps at the first 90 seconds; longer files are truncated (reported in the response).
- Audio and kit samples are decoded locally. With the server running, the optional audio→MIDI POST goes to
  the same origin for analysis; with the page open as a plain file, nothing is uploaded and the built-in
  analyser reads the samples in the page's own memory.
- Hosted, sandboxed, or opened straight off disk, **all three tabs work**: sequencer → MIDI, audio →
  MIDI, and WAV/MP3 render. The kit uses a file picker on touch devices and drag/drop where supported;
  buttons have touch-sized targets and the sequencer remains horizontally scrollable on narrow screens. The Python server is an accuracy upgrade for bass and melody, not a
  requirement for any feature.
- The one-click demos are cut from the “Midnight Kampala” beat this app grew out of; `demo/melody.wav`
  and `demo/bass.wav` are isolated stems, which is why they transcribe better than `demo/full-beat.wav`.
  Your own stems work the same way — the four demo files are 13.7 s (27.4 s for the full beat) of
  44.1 kHz mono at 140 BPM if you want to compare results against the numbers above.
- `/demo/<file>` only ever serves `.wav` files inside `demo/`; `..` and encoded separators are refused
  with a 404 (`tests/server-engine.py` asserts this).
