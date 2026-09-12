"""Accuracy benchmark for the transcriber against the known 'Midnight Kampala' arrangement.

The reference audio is not committed (see .gitignore) -- it is regenerated with
    python3 beat/make_beat.py
Set BEATFORGE_REF to point at the directory holding beat.wav and stems/ if it lives
somewhere other than the repo root. With no reference audio present the benchmark
prints instructions and exits 0, so CI stays green on a fresh clone.
"""
import os
import numpy as np, wave, sys
from scipy.signal import resample_poly

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import transcribe

REF = os.environ.get("BEATFORGE_REF", os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

REQUIRED = ["beat.wav", "stems/melody.wav", "stems/808.wav",
            "stems/kick.wav", "stems/clap.wav", "stems/hat.wav"]


def reference_audio_present():
    missing = [f for f in REQUIRED if not os.path.isfile(os.path.join(REF, f))]
    return missing


def skip(reason):
    print("\n  SKIPPED: transcription benchmark needs reference audio.")
    for m in reason:
        print(f"    missing: {os.path.join(REF, m)}")
    print("\n  Generate it with:")
    print("    python3 beat/make_beat.py          # ~3.5 min, writes beat.wav + stems/")
    print("  or point at existing audio:")
    print("    BEATFORGE_REF=/path/to/audio python3 bench.py")
    sys.exit(0)

SR=22050; BPM=140.0; SPB=60/BPM; Q=0.25*SPB

def load(path,sr=SR):
    with wave.open(path) as w:
        n=w.getnframes(); ch=w.getnchannels()
        d=np.frombuffer(w.readframes(n),dtype="<i2").reshape(-1,ch)/32768.0; fs=w.getframerate()
    m=d.mean(1)
    if fs!=sr: m=resample_poly(m,sr,fs)
    return m.astype(np.float32)

MEL_A={0:[(0,69),(3,72),(6,76),(10,74),(13,72)],1:[(0,69),(4,76),(7,74),(10,72),(12,72)],
       2:[(0,72),(2,76),(4,79),(8,77),(10,76),(12,72)],3:[(0,74),(2,71),(4,74),(8,79),(10,77),(14,74)]}
MEL_B={0:[(0,69),(5,76),(8,74),(12,72),(14,69)],1:[(0,72),(4,74),(6,69),(10,76),(13,72)],
       2:[(0,79),(4,76),(7,72),(11,76),(13,79)],3:[(0,77),(3,74),(8,79),(12,74)]}
MEL_S={k:[(st,mi) for (st,mi,*_r) in v[:3]] for k,v in MEL_A.items()}
BASS={0:[(0,45),(6,45),(10,57),(12,52)],1:[(0,41),(6,41),(10,53),(12,48)],
      2:[(0,48),(6,48),(10,60),(12,55)],3:[(0,43),(6,43),(10,55),(12,50)]}

def mel_truth(bars):
    out={}
    for b in range(1,bars+1):
        if b<=8: src,idx=MEL_B,(b-1)%4
        elif b<=20: src,idx=MEL_A,(b-1)%4
        elif b<=24: src,idx=MEL_B,(b-1)%4
        elif b<=26: continue
        elif b<=28: src,idx=MEL_S,(b-1)%4
        else: src,idx=MEL_B,(b-1)%4
        for (s,mi) in [(a,b_) for (a,b_,*_) in src[idx]]:
            out[(b-1)*16+s]=mi                  # step -> pitch
    return out

def bass_truth(bars):
    out={}
    for b in range(3,bars+1):
        if b>=31: continue
        for (s,mi) in BASS[(b-1)%4]:
            out[(b-1)*16+s]=mi
    return out

def match(det, truth, tol=1, step_s=None):
    """truth: {step: pitch} on the reference 140 BPM grid; det: [(step,pitch)].
    Matching happens in SECONDS so the result does not depend on which tempo octave
    the detector chose (70 vs 140 BPM describe the same audio)."""
    used=set(); correct=0; octave=0; other=0
    det=list(det)
    if step_s is None:
        step_s = Q
    for st, pitch in sorted(truth.items()):
        t_truth = st * Q                      # reference time of the truth note
        cand=[]
        for i,d in enumerate(det):
            if i in used: continue
            t_det = d[0] * step_s
            if abs(t_det - t_truth) <= 1.6*Q:   # +-1.6 sixteenths tolerance
                cand.append((abs(t_det-t_truth), i, d[1]))
        if not cand: continue
        cand.sort(); _,i,p2=cand[0]; used.add(i)
        if p2==pitch: correct+=1
        elif abs(p2-pitch)%12==0: octave+=1
        else: other+=1
    return correct, octave, other, len(truth), len(det)-len(used)

def report(label, det, truth, step_s=None):
    c,o,x,n,sp = match(det, truth, step_s=step_s)
    print(f"  {label:34s} recall {c}/{n} ({c/n*100:4.0f}%)  octave-err {o}  wrong-pitch {x}  spurious {sp} ({sp/len(det)*100 if det else 0:.0f}%)")
    return c/n

if __name__ == "__main__":
    _missing = reference_audio_present()
    if _missing:
        skip(_missing)
    print(f"reference audio: {REF}")
    mono=load(os.path.join(REF, "beat.wav"))
    mel_stem=load(os.path.join(REF, "stems/melody.wav"))[:len(mono)]
    bass_stem=load(os.path.join(REF, "stems/808.wav"))[:len(mono)]
    drums=np.zeros_like(mono)
    for f in ["kick","clap","hat"]:
        drums+=load(os.path.join(REF, "stems", f"{f}.wav"))[:len(mono)]
    drums=drums/np.abs(drums).max()*0.9
    BARS=24
    dur=int((BARS*4*SPB+1.0)*SR)
    mt=mel_truth(BARS); bt=bass_truth(BARS)
    print(f"MIDI transcription accuracy, bars 1-{BARS} ({dur/SR:.0f}s of audio)\n")
    def run(label, audio, mode, lane, truth):
        r = transcribe(audio, SR, mode=mode)
        ss = (60.0/r['bpm'])/(r['grid']/4.0)
        det = [(n['step'], n['pitch']) for t in r['tracks'] if t['name']==lane for n in t['notes']]
        report(f"{label}  [bpm {r['bpm']:.1f}]", det, truth, step_s=ss)
        return r
    run("melody lane / FULL MIX", mono[:dur], "melody", "Melody", mt)
    run("bass lane   / FULL MIX", mono[:dur], "melody", "Bass", bt)
    run("melody lane / isolated stem", mel_stem[:dur], "melody", "Melody", mt)
    run("bass lane   / isolated stem", bass_stem[:dur], "melody", "Bass", bt)
    KICK={0:[0,6,10.5],1:[0,6],2:[0,6,10.5,13.5],3:[0,6]}
    kt={(b-1)*16+int(s):36 for b in list(range(5,BARS+1)) for s in KICK[(b-1)%4]}
    ct={(b-1)*16+8:39 for b in range(5,BARS+1)}
    for b in range(5,BARS+1):
        if b % 4 == 3: ct[(b-1)*16+14]=39       # pickup clap on bar%4==3 (7,11,15,19,23)
    RUN_BARS=[10,12,14,18,20,22,24]
    ROLL_BARS=[8,16,24]
    ht={(b-1)*16+k*2:42 for b in range(1,BARS+1) for k in range(8)}
    for b in RUN_BARS:
        if b<=BARS:
            for st in range(8,16): ht[(b-1)*16+st]=42
    for b in ROLL_BARS:
        if b<=BARS:
            for st in (14,15): ht[(b-1)*16+st]=42
    r=transcribe(drums[:dur],SR,mode="drums")
    sdrums = (60.0/r['bpm'])/(r['grid']/4.0)
    print(f"  (drum bus detected at {r['bpm']:.1f} BPM)")
    for name,truth in [("Kick",kt),("Clap",ct),("Hh Closed",ht)]:
        det=[(n['step'],n['pitch']) for t in r['tracks'] if t['name']==name for n in t['notes']]
        c,o,x,n,sp = match(det, truth, step_s=sdrums)
        print(f"  {name+' lane / drum bus':34s} recall {c}/{n} ({c/n*100:4.0f}%)  spurious {sp} ({sp/len(det)*100 if det else 0:.0f}%)")
