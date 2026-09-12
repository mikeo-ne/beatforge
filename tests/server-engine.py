#!/usr/bin/env python3
"""Python engine smoke test -- runs the numpy/scipy analyser and the HTTP server
against the committed demo audio, so a fresh clone verifies the server half too.

Unlike bench.py (which needs the uncommitted 42 s reference arrangement and therefore
skips), everything this test needs is in the repo. It exits 0 without numpy/scipy so
the Node-only suite still passes on machines that never install them.

Run:  python3 tests/server-engine.py
"""
import base64
import json
import os
import struct
import sys
import threading
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

try:
    import numpy as np
    from scipy.signal import resample_poly
except ImportError as e:                                   # pragma: no cover
    print("\n  SKIPPED: the Python engine needs numpy + scipy.")
    print(f"    missing: {e.name}")
    print("    install with:  pip install -r requirements.txt")
    sys.exit(0)

sys.path.insert(0, ROOT)
import server                                                # noqa: E402

SR = 22050                 # what the browser sends (prepareSamples downsamples to this)
TRUE_BPM = 140.0           # the demo audio is cut from the 140 BPM reference beat
GM_DRUMS = {36: "kick", 38: "snare", 39: "clap", 42: "hh_closed", 46: "hh_open"}

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"  ({detail})" if detail else ""))
    if cond:
        passed += 1
    else:
        failed += 1


def load_mono(path, sr=SR):
    """WAV -> mono float32 at sr, the same shape the page POSTs."""
    with wave.open(path) as w:
        n, ch, fs = w.getnframes(), w.getnchannels(), w.getframerate()
        d = np.frombuffer(w.readframes(n), dtype="<i2").reshape(-1, ch) / 32768.0
    m = d.mean(1)
    if fs != sr:
        m = resample_poly(m, sr, fs)
    return m.astype(np.float32)


def demo(name):
    return os.path.join(ROOT, "demo", name)


# --------------------------------------------------------------------- MIDI parsing
def parse_smf(data):
    """Structurally validate a Standard MIDI File; returns (format, ppq, [track events])."""
    assert data[:4] == b"MThd", "not a MIDI file"
    hlen = struct.unpack(">I", data[4:8])[0]
    fmt, ntrk, ppq = struct.unpack(">HHH", data[8:14])
    pos, tracks = 8 + hlen, []
    while pos < len(data):
        assert data[pos:pos + 4] == b"MTrk", f"bad chunk id at {pos}"
        ln = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        tracks.append(parse_track(data[pos + 8:pos + 8 + ln]))
        pos += 8 + ln
    assert len(tracks) == ntrk, f"header says {ntrk} tracks, found {len(tracks)}"
    assert pos == len(data), f"{len(data) - pos} trailing bytes"
    return fmt, ppq, tracks


def parse_track(body):
    """Walk one MTrk body with running status; raises if it does not consume exactly."""
    events, i, running, tick = [], 0, None, 0

    def varint():
        nonlocal i
        v = 0
        while True:
            b = body[i]; i += 1
            v = (v << 7) | (b & 0x7F)
            if not b & 0x80:
                return v

    while i < len(body):
        tick += varint()
        st = body[i]
        if st < 0x80:
            st = running                       # running status
        else:
            i += 1; running = st
        if st is None:
            raise AssertionError("channel event before any status byte")
        if st == 0xFF:                         # meta
            mtype = body[i]; i += 1
            ln = varint()
            events.append(("meta", mtype, tick, body[i:i + ln])); i += ln
        elif st in (0xF0, 0xF7):               # sysex
            ln = varint(); i += ln
            events.append(("sysex", st, tick, b""))
        else:
            hi = st & 0xF0
            npar = 2 if hi in (0x80, 0x90, 0xA0, 0xB0, 0xE0) else 1 if hi in (0xC0, 0xD0) else 0
            par = body[i:i + npar]; i += npar
            events.append(("chan", st, tick, par))
    if i != len(body):
        raise AssertionError(f"track overran by {i - len(body)} bytes")
    if not any(e[0] == "meta" and e[1] == 0x2F for e in events):
        raise AssertionError("track has no end-of-track meta event")
    return events


def notes_of(events):
    """[(channel, pitch, on_tick, velocity)] from a parsed track."""
    out = []
    for kind, st, tick, par in events:
        if kind == "chan" and (st & 0xF0) == 0x90 and par[1] > 0:
            out.append((st & 0x0F, par[0], tick, par[1]))
    return out


def pair_notes(events):
    """Match every note-on with its note-off. Returns (ons, closed, orphan_offs, zero_len)."""
    open_notes, ons, closed, orphan, zero = {}, 0, 0, 0, 0
    for kind, st, tick, par in events:
        if kind != "chan":
            continue
        ch, hi = st & 0x0F, st & 0xF0
        if hi == 0x90 and par[1] > 0:
            ons += 1
            open_notes[(ch, par[0])] = tick
        elif hi == 0x80 or (hi == 0x90 and par[1] == 0):
            start = open_notes.pop((ch, par[0]), None)
            if start is None:
                orphan += 1
            else:
                closed += 1
                if tick <= start:
                    zero += 1
    return ons, closed, orphan, zero, len(open_notes)


# --------------------------------------------------------------------- HTTP layer
def http_checks():
    """Drive the real Handler on an ephemeral port: GET app, GET demo, POST audio2midi."""
    from http.server import ThreadingHTTPServer
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError

    class QuietHandler(server.Handler):
        def log_message(self, *a):                 # keep the test output readable
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        with urlopen(base + "/api/health", timeout=20) as r:
            check("GET /api/health", json.loads(r.read()) == {"ok": True, "service": "beatforge"},
                  f"status {r.status}")

        with urlopen(base + "/", timeout=20) as r:
            html = r.read()
        check("GET / serves the app", r.status == 200 and b"BEATFORGE" in html and b"<script>" in html,
              f"{len(html)} bytes of HTML")

        with urlopen(base + "/beatforge.html", timeout=20) as r:
            check("GET /beatforge.html", r.status == 200 and r.headers["Content-Type"].startswith("text/html"))

        with urlopen(base + "/demo/drums.wav", timeout=20) as r:
            wav = r.read()
        check("GET /demo/drums.wav", wav[:4] == b"RIFF" and len(wav) == os.path.getsize(demo("drums.wav")),
              f"{len(wav)} bytes")

        for evil in ("/demo/../server.py", "/demo/..%2fserver.py", "/demo/%2e%2e/server.py",
                     "/demo/../../etc/passwd", "/demo/../.git/config", "/demo/../../bench.py"):
            try:
                with urlopen(base + evil, timeout=20) as r:
                    r.read()
                leaked = True
            except HTTPError as e:
                leaked = e.code != 404
            check(f"{evil} is refused", not leaked, "404" if not leaked else "SERVED")

        try:
            urlopen(base + "/nope", timeout=20)
            check("unknown path 404s", False)
        except HTTPError as e:
            check("unknown path 404s", e.code == 404, f"status {e.code}")

        x = load_mono(demo("drums.wav"))
        q = "sr=22050&mode=drums&bpm=auto&sensitivity=0.5&quantize=1&grid=16"
        req = Request(base + "/api/audio2midi?" + q, data=x.astype("<f4").tobytes(),
                      headers={"Content-Type": "application/octet-stream"}, method="POST")
        with urlopen(req, timeout=60) as r:
            res = json.loads(r.read())
        check("POST /api/audio2midi", r.status == 200 and res["tracks"] and res["midi_b64"],
              f"{len(res['tracks'])} tracks, bpm {res['bpm']:.2f}, {res['stats']['notes']} notes")
        midi = base64.b64decode(res["midi_b64"])
        check("POST returns a valid SMF", midi[:4] == b"MThd" and parse_smf(midi)[0] == 1,
              f"{len(midi)} bytes")

        req = Request(base + "/api/audio2midi?sr=22050", data=b"",
                      headers={"Content-Type": "application/octet-stream"}, method="POST")
        try:
            urlopen(req, timeout=20)
            check("empty body 400s", False)
        except HTTPError as e:
            check("empty body 400s", e.code == 400, f"status {e.code}")
    finally:
        srv.shutdown()
        srv.server_close()


# --------------------------------------------------------------------- main
def main():
    print("python engine (server.py) — transcription + MIDI + HTTP\n")

    # -- drums: the lane the engine is best at
    x = load_mono(demo("drums.wav"))
    r = server.transcribe(x, SR, mode="drums")
    lanes = {t["name"]: t["notes"] for t in r["tracks"]}
    check("drums.wav tempo is 140 BPM", abs(r["bpm"] - TRUE_BPM) <= 3.0, f"{r['bpm']:.2f} detected")
    check("drums.wav found kicks", len(lanes.get("Kick", [])) >= 4, f"{len(lanes.get('Kick', []))} notes")
    check("drums.wav found hats", len(lanes.get("Hh Closed", [])) >= 8,
          f"{len(lanes.get('Hh Closed', []))} notes")
    check("drums.wav grid is 16ths", r["grid"] == 16, f"grid {r['grid']}")
    check("every drum note is a GM drum pitch",
          all(n["pitch"] in GM_DRUMS for t in r["tracks"] for n in t["notes"]),
          "kick/snare/clap/hat only")

    # -- determinism
    r2 = server.transcribe(x, SR, mode="drums")
    check("analysis is deterministic", r["bpm"] == r2["bpm"] and len(r["tracks"]) == len(r2["tracks"]),
          f"{r['bpm']:.3f} twice")

    # -- full mix: drums and pitched lanes together
    rf = server.transcribe(load_mono(demo("full-beat.wav")), SR, mode="auto")
    lf = {t["name"]: t["notes"] for t in rf["tracks"]}
    check("full-beat.wav tempo is 140 BPM", abs(rf["bpm"] - TRUE_BPM) <= 3.0, f"{rf['bpm']:.2f} detected")
    check("full-beat.wav returns drums and pitched lanes",
          all(lf.get(k) for k in ("Kick", "Hh Closed", "Bass", "Melody")),
          ", ".join(f"{k}:{len(v)}" for k, v in sorted(lf.items())))

    # -- melody stem
    rm = server.transcribe(load_mono(demo("melody.wav")), SR, mode="melody")
    mel = [n for t in rm["tracks"] if t["name"] == "Melody" for n in t["notes"]]
    check("melody.wav yields melody notes", len(mel) >= 5, f"{len(mel)} notes")
    check("melody pitches are playable MIDI notes", all(21 <= n["pitch"] <= 108 for n in mel),
          f"range {min(n['pitch'] for n in mel)}-{max(n['pitch'] for n in mel)}")
    check("note velocities are in 1..127",
          all(1 <= round(n["vel"] * 127) <= 127 for t in rm["tracks"] for n in t["notes"]))

    # -- MIDI file structure
    midi = base64.b64decode(r["midi_b64"])
    fmt, ppq, tracks = parse_smf(midi)
    check("MIDI is format 1 at 480 PPQ", fmt == 1 and ppq == 480, f"format {fmt}, {ppq} ppq")
    check("one conductor track plus one per lane", len(tracks) == len(r["tracks"]) + 1,
          f"{len(tracks)} tracks for {len(r['tracks'])} lanes")
    conductor = [e for e in tracks[0] if e[0] == "meta"]
    tempos = [struct.unpack(">I", b"\x00" + e[3])[0] for e in conductor if e[1] == 0x51]
    check("conductor track carries the detected tempo",
          tempos and abs(60_000_000 / tempos[0] - r["bpm"]) < 0.01, f"{60_000_000 / tempos[0]:.2f} BPM")
    drum_notes = [n for t in tracks[1:] for n in notes_of(t) if n[0] == 9]
    check("drums are written to channel 10", len(drum_notes) > 0 and
          all(n[1] in GM_DRUMS for n in drum_notes), f"{len(drum_notes)} note-ons")
    ons = closed = orphan = zero = unclosed = 0
    for t in tracks[1:]:
        a, b, c, d, e = pair_notes(t)
        ons += a; closed += b; orphan += c; zero += d; unclosed += e
    check("every note-on is closed by a note-off", ons == closed and unclosed == 0,
          f"{closed}/{ons} paired")
    check("no orphan note-offs", orphan == 0, f"{orphan} found")
    check("no zero-length notes", zero == 0, f"{zero} found")
    check("note ticks are non-negative and ordered",
          all(tick >= 0 for t in tracks for _, _, tick, _ in t))

    # -- the result must be JSON-serialisable exactly as the HTTP layer does it
    blob = json.loads(json.dumps(r))
    check("result round-trips through JSON", blob["bpm"] == r["bpm"] and
          len(blob["tracks"]) == len(r["tracks"]), "no numpy scalars leak into the payload")

    # -- HTTP server
    print()
    http_checks()

    print(f"\n{passed} checks passed" + (f", {failed} FAILED" if failed else ""))
    if failed:
        sys.exit(1)
    print("PYTHON ENGINE VERIFIED")


if __name__ == "__main__":
    main()
