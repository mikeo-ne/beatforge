# BEATFORGE

**Make MIDI for beat production · turn audio into MIDI · render straight to audio.**

A single self-contained web app — no build step, no dependencies, no accounts, no cloud. Open
`beatforge/beatforge.html` in a browser and everything works: an 18-genre step sequencer that exports
MIDI, an in-browser audio→MIDI transcriber, and a WAV/MP3 renderer.

The repo also contains **the beat generator this grew out of** (`beat/`) — the code that produced the
"Midnight Kampala" beat, whose stems make good test material for the transcriber.

```
open beatforge/beatforge.html          # the whole app: sequencer, transcriber, renderer
cd beatforge && python3 server.py      # optional: adds the more accurate Python analyser
```

---

## What's in the app

### 🎛 Step sequencer → MIDI
Program 8 lanes (kick, clap, snare, closed/open hat, 808 bass, melody, pad) on a 16th grid with
swing and per-lane mute, hear it immediately through Web Audio synthesis (no samples required),
then export.

- **18 genres** in four families, each written as its real signature groove:

  | Family | Genres |
  |---|---|
  | Hip-hop | Trap 140 · Boom bap 90 · Drill 144 · Lo-fi 85 · Grime 140 · Phonk 130 |
  | Club & bass | House 124 · Techno 132 · UK garage 134 · Jersey club 135 · Drum & bass 174 · Dubstep 140 |
  | Afro & Caribbean | Afrobeats 106 · Amapiano 112 · Dancehall 100 · Reggaeton 95 |
  | Pop & funk | Pop/EDM 128 · Funk/breakbeat 105 |

  Loading a genre sets tempo, bars, swing and pattern together. These are the actual rhythms, not
  approximations: house is four-on-the-floor with offbeat bass and open hats; reggaeton is a true
  dembow (kick on 1 & 3, snare on 3/6/11/14); dubstep is half-time with the snare on beat 3;
  drum & bass is a 2-step break with ghost snares; amapiano is a log-drum bass sliding through the
  scale under a 16th shaker; dancehall is a one-drop bounce.
- **Genre-aware Randomise** — keeps the loaded style's feel, drops/adds hits, and moves pitches within
  that genre's root and mode (minor / dorian / major / phrygian).
- **Export .MID** — Standard MIDI File, type 1, 480 PPQ. Drums go to channel 10 with General MIDI note
  numbers (kick 36, snare 38, clap 39, closed hat 42, open hat 46), so it lands on a Drum Kit Designer
  track in Logic Pro and lines up immediately.

### 🎧 Audio → MIDI
Drop in a drum loop, bassline, melody or full beat. You get a multi-track MIDI file plus an on-screen
note timeline, which can be pushed straight into the sequencer to edit.

**Two independent engines**, so it never depends on a server:

| | Python engine (`server.py`) | In-browser engine |
|---|---|---|
| Needs install | numpy + scipy | nothing — it's inside the HTML |
| Works offline / from a downloaded file | no | **yes** |
| Speed (42 s of audio) | 0.2–1.2 s | 0.9–1.5 s |
| Best for | bass + melody, dense mixes | drums, loops, zero-setup use |

The page uses the Python engine when it's reachable and silently falls back to its built-in one.

### 🎧 Render to audio
**Render WAV** bounces the pattern with `OfflineAudioContext` — faster than real time, through the same
voices and master chain you hear — as 44.1 kHz 16-bit stereo, normalised to −0.4 dBFS with a 2 s tail,
×1/×2/×4/×8 loops. **MP3** uses WebCodecs (`AudioEncoder`) where the browser ships it; if it isn't
available the button says so instead of failing quietly, so WAV is the path that always works.

---

## Measured accuracy

Not claims — `bench.py` and the test suite print these numbers. Reference: a known 140 BPM arrangement,
42 s of audio, bars 1–24, scored in the time domain so the result doesn't depend on which tempo octave
was chosen.

**Drum lanes** (server / in-browser engines):

| Lane | Recall | Precision |
|---|---|---|
| Kick | **100%** / **100%** | 100% / 100% |
| Clap | 92% / **100%** | 96% / 100% |
| Closed hat | 70% / 59% | 97% / 76% |
| Tempo | 140.0 vs 140.0 true | — |

**Pitched lanes** (server engine): bass 59% of a full mix, melody 40% of a full mix, 58% from an isolated
stem.

How the drum lanes got to 100% — three findings that each required changing the algorithm:

1. **Spectral flux is scale-invariant.** Near-silent low-frequency ripple produces as much "flux" as a
   real kick (a false kick at 7.18 s measured 4.8 flux but only 12% of a real kick's energy). Fixed with
   an attack test on absolute band energy — kick false positives went 30% → 0%.
2. **A kick's pitch sweep (150 → 46 Hz) crosses several FFT bins**, manufacturing ~5 onsets per hit. So
   per-band peak picking is only safe for the high band; the detector is hybrid — the combined envelope
   for kick/clap, the high band for hats that the combined envelope misses under a loud kick.
3. **The benchmark itself was wrong** in two places (hats only listed from bar 5, pickup claps on the
   wrong bars), which was understating precision.

**Honest limitations.** Hats lose roughly a third of quiet 16th runs. Bass and melody recall wants the
Python engine and stems rather than a full mix — single-channel transcription cannot separate a melody
from a sustaining pad underneath it; that needs source separation. The 70-vs-140 BPM question is
genuinely ambiguous for half-time material, so there's a manual tempo field and ×2 / ÷2 buttons.

---

## Tests

```sh
cd beatforge && sh tests/run-all.sh
```

| Test | What it asserts |
|---|---|
| `tests/genre-rhythms.cjs` | 22 checks that each genre's signature rhythm is correct (four-on-the-floor, dembow placement, half-time snare, ghost notes, triplet kicks, swung 8ths) |
| `tests/genre-export.cjs` | loads all 18 genres, range-checks every step and pitch, builds and validates a MIDI file for each |
| `tests/wav-render.cjs` | offline render produces real PCM through the synth voices and master chain |
| `tests/mp3-path.cjs` | WebCodecs plumbing: planar channel split, frame chunking, MPEG sync word |
| `tests/browser-engine.cjs` | the in-browser analyser end to end (tempo, lanes, MIDI bytes) |
| `bench.py` | transcription accuracy against the reference arrangement (skips cleanly if the reference audio isn't present) |

CI runs the whole suite on every push — see `.github/workflows/tests.yml`.

---

## Repo layout

```
beatforge/                 the app
  beatforge.html           everything: UI, sequencer, synth, renderer, in-browser analyser
  server.py                optional Python engine: HTTP server + transcription
  local-engine.js          source for the in-browser analyser (inlined into the HTML)
  bench.py                 transcription benchmark
  tests/                   the suite + a DOM/AudioContext shim for headless Node runs
  demo/                    demo audio for the one-click demos

beat/                      the beat generator this started as
  make_beat.py             synthesises, arranges, mixes and masters a beat from scratch
  export_midi.py           writes the arrangement as MIDI (one file per instrument)
  LOGIC_PRO_GUIDE.md       how to rebuild the beat inside Logic Pro
  midi/  beat.mid          example MIDI output
```

## Running the beat generator

```sh
cd beat && python3 make_beat.py     # ~3.5 min -> beat.wav + stems/ + midi/
```

It renders a 32-bar beat at 140 BPM in A minor — 808 with glide, kick/clap/hats, a bell melody, pads,
vinyl texture, reverb and a limited master chain — then `export_midi.py` writes the parts as MIDI.
The WAV output is gitignored; regenerate it rather than cloning 70 MB of audio. See
[`beat/LOGIC_PRO_GUIDE.md`](beat/LOGIC_PRO_GUIDE.md) for the rebuild recipe.

---

## Requirements

The app needs only a modern browser. `numpy` + `scipy` (`requirements.txt`) are needed for the optional
Python engine, the benchmark, and the beat generator.

## License

MIT — see [LICENSE](LICENSE).
