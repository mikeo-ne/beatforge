#!/usr/bin/env python3
"""
BEATFORGE — backend.

Serves the self-contained app and provides the audio -> MIDI transcription API.
Pure stdlib + numpy/scipy, so it runs anywhere with no install step.

API
  GET  /                    the app
  GET  /demo/<file>         demo audio
  POST /api/audio2midi      body: raw little-endian float32 mono PCM
                            query: sr, mode(auto|drums|melody), bpm(auto|number),
                                   sensitivity(0..1), quantize(0..1), grid(4|8|16|32)
  GET  /api/health
"""
import base64
import json
import os
import struct
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import numpy as np
from scipy.signal import butter, sosfilt

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_SECONDS = 90.0          # analysis cap
GM = {"kick": 36, "snare": 38, "clap": 39, "hh_closed": 42, "hh_open": 46, "crash": 49}


# --------------------------------------------------------------------------- utils
def lp(x, fc, sr, order=4):
    fc = min(fc, sr * 0.45)
    sos = butter(order, fc / (sr / 2), btype="low", output="sos")
    return sosfilt(sos, x).astype(np.float32)


def hp(x, fc, sr, order=4):
    fc = max(fc, 15.0)
    if fc >= sr * 0.45:
        return x.astype(np.float32)
    sos = butter(order, fc / (sr / 2), btype="high", output="sos")
    return sosfilt(sos, x).astype(np.float32)


def bp(x, f1, f2, sr, order=4):
    f1, f2 = max(f1, 15.0), min(f2, sr * 0.45)
    sos = butter(order, [f1 / (sr / 2), f2 / (sr / 2)], btype="band", output="sos")
    return sosfilt(sos, x).astype(np.float32)


def band_energy(x, sr):
    return float(np.sqrt(np.mean(x ** 2)) + 1e-12)


def frame_stft(x, n_fft, hop):
    """Simple magnitude STFT -> (n_frames, n_bins)."""
    win = np.hanning(n_fft).astype(np.float32)
    n_frames = 1 + max(0, (len(x) - n_fft) // hop)
    if n_frames < 2:
        return np.zeros((2, n_fft // 2 + 1), dtype=np.float32)
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = x[idx] * win
    spec = np.fft.rfft(frames, axis=1)
    return np.abs(spec).astype(np.float32)


# --------------------------------------------------------------------------- onsets
def onset_envelope(x, sr, n_fft=1024, hop=220):
    """Per-band whitened spectral flux -> (envelope, fps, frame_offset, bands).

    Two details matter for correctness:
      * flux is averaged over a band's bins, not summed -- otherwise the wide high
        band (hundreds of bins) always dwarfs the narrow sub band (a handful of bins)
        and kicks become invisible;
      * a band is only used if it actually carries energy in this material, so a
        silent band's noise floor can't be amplified by the per-band normalisation.
    """
    S = frame_stft(x, n_fft, hop)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    groups = {"sub": freqs < 140,
              "mid": (freqs >= 140) & (freqs < 3000),
              "high": freqs >= 3000}
    total_energy = float(S.sum()) + 1e-9
    raw, present = {}, []
    for name, g in groups.items():
        if not np.any(g):
            raw[name] = None
            continue
        band_share = float(S[:, g].sum()) / total_energy
        if band_share < 0.005:                     # band not really present
            raw[name] = None
            continue
        F = np.log1p(S[:, g] * 40.0)
        fl = np.concatenate([[0.0], np.maximum(np.diff(F, axis=0), 0.0).mean(axis=1)])
        raw[name] = fl
        present.append(fl)
    if not present:
        return np.zeros(S.shape[0], dtype=np.float32), sr / hop, (n_fft / 2) / sr, \
               {k: np.zeros(S.shape[0]) for k in groups}

    means = np.array([f.mean() for f in present]) + 1e-9
    floor = 0.20 * float(means.mean())             # partial whitening, avoids noise amplification
    env = np.zeros(S.shape[0])
    bands = {}
    for name, fl in raw.items():
        if fl is None:
            bands[name] = np.zeros(S.shape[0])
            continue
        norm = max(float(fl.mean()), floor)
        nf = fl / norm
        bands[name] = nf
        env += nf
    env = np.convolve(env, np.array([0.2, 0.6, 0.2]), mode="same")
    m = float(env.max())
    if m > 0:
        env /= m
        for k in bands:
            bands[k] = bands[k] / (env.max() + 1e-9) if False else bands[k]
    return env.astype(np.float32), sr / hop, (n_fft / 2) / sr, bands


def pick_peaks(env, fps, sensitivity=0.5, min_gap_s=0.045, floor_ratio=0.0):
    """Adaptive-threshold peak picking (moving local mean + sensitivity)."""
    if len(env) < 5:
        return np.array([])
    win = max(3, int(0.45 * fps)) | 1
    pad = np.pad(env, win // 2, mode="edge")
    cs = np.concatenate([[0.0], np.cumsum(pad)])
    local_mean = (cs[win:win + len(env)] - cs[:len(env)]) / win
    k = 0.55 - 0.45 * sensitivity
    floor = 0.012 + 0.05 * (1.0 - sensitivity)
    if floor_ratio > 0:
        # an absolute floor has to be tuned for one signal; scaling to the band's own
        # 90th percentile works across quiet (sub) and busy (high) bands alike
        floor = max(floor, floor_ratio * float(np.percentile(env, 90)))
    thresh = np.maximum(local_mean * (1.0 + k), floor)
    gap = max(1, int(min_gap_s * fps))
    peaks = []
    i = 1
    while i < len(env) - 1:
        if env[i] > thresh[i] and env[i] >= env[i - 1] and env[i] >= env[i + 1]:
            lo, hi = max(0, i - int(0.05 * fps)), min(len(env), i + int(0.05 * fps))
            if env[i] >= env[lo:hi].max() - 1e-9:
                peaks.append(i)
                i += gap
                continue
        i += 1
    return np.array(peaks, dtype=int)


# --------------------------------------------------------------------------- tempo
def detect_tempo(env, fps, lo=60.0, hi=190.0, steps_per_bar=16, frame_offset=0.0):
    """Tempo + grid phase.

    Pipeline: autocorrelation with comb scoring for a coarse period -> refine the
    period against the onset envelope (a 0.1% period error drifts a whole 16th note
    over 20 bars, so refinement is not optional) -> compare the half/double octaves
    including a musical-tempo prior -> final phase from the onset phase distribution.
    """
    if len(env) < 16 or not np.any(env):
        return 120.0, 0.0, 0.0
    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    ac = ac / (ac[0] + 1e-12)
    min_lag, max_lag = int(fps * 60.0 / hi), int(fps * 60.0 / lo)
    max_lag = min(max_lag, len(ac) - 2)
    if max_lag <= min_lag:
        return 120.0, 0.0, 0.0
    best_lag, best_score, scores = min_lag, -1e9, {}
    for lag in range(min_lag, max_lag + 1):
        sc = ac[lag]
        for m in (2, 3, 4):
            if lag * m < len(ac):
                sc += (0.5 / m) * ac[lag * m]
        bpm_l = 60.0 * fps / lag
        sc *= 1.0 + 0.12 * np.exp(-((bpm_l - 120.0) / 60.0) ** 2)
        scores[lag] = sc
        if sc > best_score:
            best_lag, best_score = lag, sc
    coarse = 60.0 * fps / best_lag
    vals = np.array(list(scores.values()))
    conf = float(np.clip((best_score - vals.mean()) / (vals.std() + 1e-9), 0, 6) / 6.0)

    def acf_at(b):
        i = int(round(60.0 * fps / b))
        return float(ac[i]) if 1 <= i < len(ac) else -1.0

    def grid_energy(b, div=4.0):
        """Mean onset strength landing on the grid -- used both to refine the period
        and to measure how well a tempo explains the onsets."""
        step_p = (60.0 / b) / div
        if step_p <= 0:
            return -1.0
        best = -1.0
        for ph in np.arange(0.0, step_p, step_p / 6.0):
            n = int((len(env) / fps - ph) / step_p) + 1
            if n < 8:
                continue
            idx = np.round(((ph + np.arange(n) * step_p) - frame_offset) * fps).astype(int)
            idx = idx[(idx >= 0) & (idx < len(env))]
            if len(idx) < 8:
                continue
            # tolerate sub-frame jitter by taking the local max within +-2 frames
            lo_ = np.clip(idx - 2, 0, len(env) - 1)
            hi_ = np.clip(idx + 3, 0, len(env))
            vals = np.array([env[a:b].max() for a, b in zip(lo_, hi_)])
            best = max(best, float(vals.mean()))
        return best

    def refine(b0):
        """Coarse-to-fine period search: alignment improves sharply at the true tempo."""
        best_b, best_v = b0, grid_energy(b0)
        for step in (0.004, 0.0012):
            cands = np.arange(best_b * (1 - 3 * step), best_b * (1 + 3 * step), best_b * step)
            for c in cands:
                v = grid_energy(float(c))
                if v > best_v:
                    best_b, best_v = float(c), v
        return best_b, best_v

    def prior(b):
        if b < 65.0 or b > 200.0:
            return -1.0
        return float(np.exp(-((np.log2(b / 118.0)) / 0.42) ** 2))

    def phase_coherence(b):
        step_p = (60.0 / b) / 4.0
        peaks = pick_peaks(env, fps, 0.5)
        if len(peaks) < 4:
            return 0.0
        ts = peaks / fps + frame_offset
        w = env[peaks].astype(np.float64)
        resid = (ts - (ts[0] % step_p)) / step_p
        resid = np.abs(resid - np.round(resid))
        return float((w * np.cos(2 * np.pi * resid)).sum() / (w.sum() + 1e-9))

    results = []
    for m in (0.5, 1.0, 2.0):
        b = coarse * m
        if not (lo <= b <= hi):
            continue
        br, fit = refine(b)
        sc = 0.45 * acf_at(br) + 1.10 * prior(br) + 0.30 * phase_coherence(br) + 0.25 * fit
        results.append((sc, br))
    bpm = max(results)[1] if results else coarse

    # --- phase: circular mean of the onset phases, weighted by onset strength
    step = (60.0 / bpm) / (steps_per_bar / 4.0)
    peaks = pick_peaks(env, fps, 0.5)
    if len(peaks) < 3:
        return float(bpm), 0.0, conf
    times = peaks / fps + frame_offset
    w = env[peaks].astype(np.float64)
    phases = (times % step) / step * 2 * np.pi
    cos, sin = float((w * np.cos(phases)).sum()), float((w * np.sin(phases)).sum())
    if abs(cos) < 1e-9 and abs(sin) < 1e-9:
        return float(bpm), 0.0, conf
    offset = (np.arctan2(sin, cos) / (2 * np.pi)) * step
    while offset > step * 0.5:
        offset -= step
    offset = max(0.0, offset)
    return float(bpm), float(offset), conf


# --------------------------------------------------------------------------- drums
def band_signals(x, sr):
    """Whole-signal band split + cumulative energy, so window energies are exact and
    free of short-segment filter ringing."""
    bands = {
        "sub": bp(x, 25, 90, sr, 4),
        "low": bp(x, 90, 350, sr, 4),
        "mid": bp(x, 350, 3000, sr, 4),
        "high": hp(x, 5000, sr, 4),
        "all": x,
    }
    return {k: np.concatenate([[0.0], np.cumsum(v.astype(np.float64) ** 2)]) for k, v in bands.items()}


def _win_rms(cum, i0, i1):
    total = len(cum) - 1                     # cum has one extra leading sample
    i0 = max(0, min(int(i0), total - 1))
    i1 = max(i0 + 1, min(int(i1), total))
    return float(np.sqrt(max(0.0, cum[i1] - cum[i0]) / (i1 - i0)))


def strip_decay(cum, sr, t):
    """Decay estimate that subtracts the ambient (sustained) level, so an open hat is
    still detected when a pad or melody is ringing underneath it."""
    pre = _win_rms(cum["high"], int((t - 0.200) * sr), int((t - 0.060) * sr))
    atk = _win_rms(cum["high"], int((t - 0.003) * sr), int((t + 0.045) * sr))
    tail = _win_rms(cum["high"], int((t + 0.060) * sr), int((t + 0.200) * sr))
    denom = atk - pre
    decay_h = (tail - pre) / denom if denom > 1e-9 else 0.0
    pre2 = _win_rms(cum["all"], int((t - 0.200) * sr), int((t - 0.060) * sr))
    atk2 = _win_rms(cum["all"], int((t - 0.003) * sr), int((t + 0.045) * sr))
    tail2 = _win_rms(cum["all"], int((t + 0.060) * sr), int((t + 0.200) * sr))
    den2 = atk2 - pre2
    decay_all = (tail2 - pre2) / den2 if den2 > 1e-9 else 0.0
    return float(np.clip(decay_h, 0, 2)), float(np.clip(decay_all, 0, 2))


def classify_drum(bands, cum, sr, frame, t):
    """Return a LIST of (lane, velocity): coincident hits are kept, so a kick landing
    on the same 16th as a hat produces both notes."""
    f_sub = float(bands["sub"][frame])
    f_mid = float(bands["mid"][frame])
    f_high = float(bands["high"][frame])
    strongest = max(f_sub, f_mid, f_high) + 1e-9
    keys = ("kick", "clap", "hh")
    flux = {"kick": f_sub, "clap": f_mid, "hh": f_high}

    # coincident hits are kept: a kick under a hat is the most common combination in
    # beats, so sub+high both firing should produce two notes. Claps need a stronger
    # mid cue because melodic attacks also land in the mid band.
    LANE_MIN = {"kick": 0.45, "hh": 0.45, "clap": 0.60}
    primary = max(flux, key=flux.get)
    out = []
    for lane in keys:
        co = flux[lane] / strongest                  # 0 .. 1
        if co < LANE_MIN[lane] and lane != primary:
            continue
        if co < 0.30 and lane != primary:
            continue
        vel = float(np.clip(0.45 + 0.5 * co, 0.4, 1.0))
        if lane == "kick":
            out.append(("kick", vel))
        elif lane == "hh":
            decay_h, decay_all = strip_decay(cum, sr, t)
            open_hat = decay_h > 0.30 or decay_all > 0.30
            out.append(("hh_open" if open_hat else "hh_closed", vel))
        else:
            low_body = _win_rms(cum["low"], int((t - 0.003) * sr), int((t + 0.045) * sr))
            mid_atk = _win_rms(cum["mid"], int((t - 0.003) * sr), int((t + 0.045) * sr))
            out.append(("snare" if low_body > 0.55 * mid_atk else "clap", vel))
    if not out:
        out.append(("hh_closed", 0.4))
    return out


def detect_drums(x, sr, env, fps, sens, frame_offset, bands, melodic_times=()):
    """Hybrid onset detection, which is what the measurements turned out to require.

    Kicks and claps: onsets from the combined envelope. That is reliable for them --
    but it silently drops a quiet hat that lands on the same 16th as a loud kick.

    Hats: onsets from the high band on their own, added only where the combined
    envelope found nothing nearby. Per-band detection is *only* safe for the high
    band here: a kick's pitch sweep (150 -> 46 Hz) crosses several FFT bins and
    generates a handful of rising-flux peaks per hit, so picking per band in the sub
    range invents kicks. Adding the high band back recovers the coincident hats
    without that artifact.
    """
    cum = band_signals(x, sr)
    melodic = np.array(sorted(melodic_times), dtype=float) if len(melodic_times) else np.array([])

    # --- source A: combined envelope
    peaks_a = pick_peaks(env, fps, sens)
    # --- source B: high band only
    fl_high = bands.get("high")
    peaks_b = pick_peaks(fl_high, fps, sens, min_gap_s=0.045, floor_ratio=0.24) \
        if (fl_high is not None and fl_high.max() > 0) else np.array([], dtype=int)

    def feats(p):
        f_sub, f_mid, f_high = float(bands["sub"][p]), float(bands["mid"][p]), float(bands["high"][p])
        tot = f_sub + f_mid + f_high + 1e-9
        return f_sub, f_mid, f_high, f_sub / tot, f_mid / tot, f_high / tot

    hits = []

    # --- A: classify with the band-ratio decision tree (measured best for kick/clap)
    for p in peaks_a:
        t = float(p / fps + frame_offset)
        if t < 0:
            continue
        f_sub, f_mid, f_high, sh_sub, sh_mid, sh_high = feats(p)
        # an 808 note is a pure sine: sub-only attack that lines up with a pitched note
        if (len(melodic) and sh_sub > 0.45
                and (f_mid + f_high) < 0.30 * f_sub
                and np.abs(melodic - t).min() < 0.045):
            continue
        for lane, vel in classify_drum(bands, cum, sr, p, t):
            if lane == "kick" and attack_ratio(cum, sr, t, "sub") < 0.32:
                continue                       # low-frequency ripple, not a kick attack
            if lane == "clap" and attack_ratio(cum, sr, t, "mid") < 0.20:
                continue
            hits.append({"time": t, "lane": lane, "vel": float(vel)})

    # --- B: high-band-only onsets the combined envelope missed.
    # Dedupe against existing HAT hits only -- a hat landing on the same 16th as a
    # kick still needs to be added, even though the combined envelope fired there.
    hat_times = np.array([h["time"] for h in hits if h["lane"] in ("hh_closed", "hh_open")]) \
        if hits else np.array([])
    for p in peaks_b:
        t = float(p / fps + frame_offset)
        if t < 0:
            continue
        if len(hat_times) and np.abs(hat_times - t).min() < 0.030:
            continue                       # this hat is already accounted for
        f_sub, f_mid, f_high, sh_sub, sh_mid, sh_high = feats(p)
        if sh_high < 0.30:
            continue
        if len(melodic) and np.abs(melodic - t).min() < 0.030 and sh_high < 0.5:
            continue
        dh, da = strip_decay(cum, sr, t)
        vel = float(np.clip(0.35 + 0.5 * min(1.0, complex_vel(fl_high, p)), 0.35, 0.9))
        hits.append({"time": t, "lane": "hh_open" if (dh > 0.34 or da > 0.34) else "hh_closed",
                     "vel": vel})

    # --- per-lane dedupe
    out = []
    for lane in ("kick", "snare", "clap", "hh_closed", "hh_open"):
        items = sorted([h for h in hits if h["lane"] == lane], key=lambda h: h["time"])
        kept = []
        for h in items:
            if kept and h["time"] - kept[-1]["time"] < 0.035:
                if h["vel"] > kept[-1]["vel"]:
                    kept[-1] = h
                continue
            kept.append(h)
        out.extend(kept)
    out.sort(key=lambda h: h["time"])
    return out


def attack_ratio(cum, sr, t, band, pre=0.030, atk=0.040):
    """How much a band's energy RISES across an onset: 1 when it comes out of silence,
    0 when the level was already there.

    Spectral flux alone is scale-invariant, because it works on log magnitudes -- a
    whisper of low-frequency ripple in near-silence produces just as much "flux" as a
    real kick. Measured on the reference material, a false kick at 7.18 s had 4.8 flux
    but only 12% of a real kick's sub-band energy. This ratio is what separates them.
    """
    if band not in cum:
        return 1.0
    c = cum[band]
    e_pre = _win_rms(c, int((t - pre) * sr), int((t - 0.005) * sr))
    e_atk = _win_rms(c, int((t + 0.002) * sr), int((t + atk) * sr))
    return float((e_atk - e_pre) / (e_atk + 1e-12))


def complex_vel(fl, p):
    """Relative strength of a peak against the band's 90th percentile."""
    try:
        ref = np.percentile(fl, 90) + 1e-9
        return float(fl[p]) / ref
    except Exception:
        return 0.5


# --------------------------------------------------------------------------- pitch
def yin_track(x, sr, fmin=40.0, fmax=1000.0, frame=2048, hop=256, thresh=0.16):
    """YIN pitch track -> (times, freqs, voiced_confidence). freq=0 where unvoiced."""
    n_frames = 1 + max(0, (len(x) - frame) // hop)
    if n_frames < 2:
        return np.array([]), np.array([]), np.array([])
    tau_min = max(2, int(sr / fmax))
    tau_max = min(frame - 2, int(sr / fmin))
    rms = np.sqrt(np.convolve(x.astype(np.float64) ** 2, np.ones(hop) / hop, mode="same"))
    gate = max(1e-4, rms.max() * 0.012)
    freqs = np.zeros(n_frames, dtype=np.float64)
    confs = np.zeros(n_frames, dtype=np.float64)
    loud = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        s = i * hop
        seg = x[s:s + frame].astype(np.float64)
        cur_rms = rms[min(s + hop // 2, len(rms) - 1)]
        if cur_rms < gate:
            continue
        seg = seg - seg.mean()
        if not np.any(seg):
            continue
        nfft = 1
        while nfft < 2 * frame:
            nfft *= 2
        spec = np.fft.rfft(seg, nfft)
        acf = np.fft.irfft(spec * np.conj(spec), nfft)[:tau_max + 1]
        csum = np.concatenate([[0.0], np.cumsum(seg ** 2)])
        sq2 = np.concatenate([[0.0], np.cumsum(seg[::-1] ** 2)])  # for lagged power
        taus = np.arange(tau_max + 1)
        p0 = csum[frame] - csum[0]
        # power of the lagged half (approximate with the same frame power)
        d = 2.0 * (p0 - acf)
        d[0] = 0.0
        cmnd = np.ones_like(d)
        run = np.cumsum(d)
        cmnd = d * taus / (run + 1e-12)
        cmnd[0] = 1.0
        # first local minimum below threshold
        tau = -1
        for tt in range(tau_min, tau_max):
            if cmnd[tt] < thresh and cmnd[tt] <= cmnd[tt + 1]:
                tau = tt
                break
        if tau < 0:
            seg_cmnd = cmnd[tau_min:tau_max]
            if len(seg_cmnd) == 0:
                continue
            tau = tau_min + int(np.argmin(seg_cmnd))
            if cmnd[tau] > 0.45:
                continue
        # parabolic refinement
        if 0 < tau < len(cmnd) - 1:
            a, b, c = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
            denom = (a - 2 * b + c)
            if abs(denom) > 1e-12:
                tau = tau + 0.5 * (a - c) / denom
        if tau <= 0:
            continue
        f0 = sr / tau
        if fmin <= f0 <= fmax:
            freqs[i] = f0
            confs[i] = float(np.clip(1.0 - cmnd[int(round(tau))], 0, 1))
            loud[i] = float(cur_rms)
    times = (np.arange(n_frames) * hop) / sr
    return times, freqs, confs, loud


def segments_to_notes(times, freqs, confs, loud, min_dur=0.055, midi_lo=21, midi_hi=108,
                      settle_s=0.022):
    """Group voiced frames into notes and report a loudness-weighted pitch.

    A pluck that decays under a sustaining pad is loudest right at its attack, so the
    pitch estimate is weighted by (frame loudness x confidence^2) instead of being a
    plain average over the whole note. A segment whose weight is spread across several
    semitones (two sounds trading the lead) is rejected rather than reported as a
    confidently wrong note.
    """
    notes = []

    def close(seg):
        if seg is None:
            return
        if seg["t_end"] - seg["t0"] < min_dur or not seg["vals"]:
            return
        vals = np.array(seg["vals"], dtype=float)
        t_v = np.array(seg["vt"], dtype=float)
        w = np.array(seg["w"], dtype=float)
        keep = (t_v - seg["t0"]) >= settle_s
        if keep.sum() >= 1:
            vals, w = vals[keep], w[keep]
        order = np.argsort(vals)
        vals, w = vals[order], w[order]
        cw = np.cumsum(w)
        if cw[-1] <= 0:
            return
        med = float(vals[np.searchsorted(cw, 0.5 * cw[-1])])
        # how much of the weight sits within half a semitone of that pitch?
        dom = float(w[np.abs(vals - med) <= 0.5].sum() / cw[-1])
        if dom < 0.45:
            return
        notes.append({"t0": seg["t0"], "t1": seg["t_end"], "midi": int(round(med)),
                      "conf": seg["conf"] * min(1.0, dom)})

    seg = None
    for t, f, c, l in zip(times, freqs, confs, loud):
        midi = None
        if f > 0 and c > 0.25:
            m = int(round(69 + 12 * np.log2(f / 440.0)))
            if midi_lo <= m <= midi_hi:
                midi = m
        if midi is None:
            close(seg)
            seg = None
            continue
        if seg is None or abs(midi - np.median(seg["vals"])) > 0.75:
            close(seg)
            seg = {"t0": t, "t_end": t, "vals": [midi], "vt": [t],
                   "w": [max(1e-9, l * c * c)], "conf": c}
        else:
            seg["vals"].append(midi)
            seg["vt"].append(t)
            seg["w"].append(max(1e-9, l * c * c))
            seg["t_end"] = t
            seg["conf"] = max(seg["conf"], c)
    close(seg)
    return notes


def merge_adjacent(notes, gap_s):
    """Join notes of the same pitch that are separated by a tracking drop-out."""
    if not notes:
        return notes
    notes = sorted(notes, key=lambda n: n["t0"])
    out = [dict(notes[0])]
    for n in notes[1:]:
        last = out[-1]
        if n["midi"] == last["midi"] and (n["t0"] - last["t1"]) <= gap_s:
            last["t1"] = max(last["t1"], n["t1"])
            last["conf"] = max(last["conf"], n["conf"])
        else:
            out.append(dict(n))
    return out


def dedupe(notes, step_s, max_per_step=1):
    """Keep the most confident note when several land on the same grid step."""
    buckets = {}
    for n in notes:
        k = int(round(n["t0"] / step_s))
        if k not in buckets or n["conf"] > buckets[k]["conf"]:
            buckets[k] = n
    return [buckets[k] for k in sorted(buckets)]


# --------------------------------------------------------------------------- quantise
def quantize_time(t, offset, step_s, strength):
    if strength <= 0.001:
        return t
    grid = (t - offset) / step_s
    snapped = round(grid) * step_s + offset
    if snapped < 0:
        snapped = 0.0
    return t + (snapped - t) * strength


# --------------------------------------------------------------------------- MIDI
def vlq(n):
    out = bytearray([n & 0x7F])
    n >>= 7
    while n:
        out.insert(0, 0x80 | (n & 0x7F))
        n >>= 7
    return bytes(out)


def write_smf(tracks, bpm, ppq=480, name="BEATFORGE"):
    """tracks: list of (track_name, channel, [(start_beats, midi, dur_beats, vel)])"""
    chunks = []
    # conductor track: tempo + time signature + name
    t0 = bytearray()
    t0 += b"\x00\xff\x03" + bytes([len(name)]) + name.encode()
    copyright_text = b"Copyright (c) Mike 1ne, Sound Engineer / 7H Music Group"
    t0 += b"\x00\xff\x02" + bytes([len(copyright_text)]) + copyright_text
    us_per_beat = int(round(60_000_000 / bpm))
    t0 += b"\x00\xff\x51\x03" + struct.pack(">I", us_per_beat)[1:]
    t0 += b"\x00\xff\x58\x04\x04\x02\x18\x08"
    t0 += b"\x00\xff\x2f\x00"
    chunks.append(bytes(t0))

    for tname, chan, notes in tracks:
        ev = []
        prepared = sorted([(float(start), int(pitch), float(dur), vel) for start, pitch, dur, vel in notes],
                          key=lambda x: x[0])
        for ix, (start, pitch, dur, vel) in enumerate(prepared):
            if any(x[0] == start and x[1] == pitch for x in prepared[:ix]):
                continue
            later = next((x[0] for x in prepared[ix + 1:] if x[0] > start and x[1] == pitch), None)
            if later is not None and later <= start:
                continue
            length = max(1e-4, min(max(dur, 1e-4), later - start if later is not None else max(dur, 1e-4)))
            ev.append((start, 0, pitch, int(np.clip(vel, 1, 127)), chan))
            ev.append((start + length, 1, pitch, 0, chan))
        ev.sort(key=lambda e: (e[0], -e[1]))
        buf = bytearray()
        buf += b"\x00\xff\x03" + bytes([len(tname) & 0x7F]) + tname.encode()[:127]
        last = 0.0
        for (t, is_off, pitch, vel, ch) in ev:
            ticks = int(round(t * ppq))
            delta = max(0, ticks - int(round(last * ppq)))
            buf += vlq(delta)
            if is_off:
                buf += bytes([0x80 | ch, pitch, 0x40])
            else:
                buf += bytes([0x90 | ch, pitch, vel])
            last = t
        buf += b"\x00\xff\x2f\x00"
        chunks.append(bytes(buf))

    header = b"MThd" + struct.pack(">IHHH", 6, 1, len(chunks), ppq)
    return header + b"".join(b"MTrk" + struct.pack(">I", len(c)) + c for c in chunks)


# --------------------------------------------------------------------------- pipeline
def transcribe(x, sr, mode="auto", bpm_override=None, sens=0.5, quant=1.0, grid=16):
    if sr <= 0 or len(x) < sr // 4:
        raise ValueError("audio too short")
    x = np.nan_to_num(x.astype(np.float32))
    x = x - float(np.mean(x))
    peak = float(np.max(np.abs(x))) or 1.0
    x = x / peak * 0.95

    env, fps, frame_offset, bands = onset_envelope(x, sr)
    if bpm_override and bpm_override > 20:
        bpm = float(bpm_override)
        _, offset, _ = detect_tempo(env, fps, steps_per_bar=float(grid),
                                    frame_offset=frame_offset)
        conf = 1.0
    else:
        bpm, offset, conf = detect_tempo(env, fps, steps_per_bar=float(grid),
                                         frame_offset=frame_offset)

    beat = 60.0 / bpm
    step_s = beat / (grid / 4.0)                 # grid = steps per bar (16 = 16ths)
    bar_s = beat * 4.0
    total_bars = max(1, int(np.ceil((len(x) / sr - offset) / bar_s)))

    tracks = []
    stats = {"onsets": 0, "notes": 0, "bpm": round(bpm, 2),
             "confidence": round(conf, 2), "bars": total_bars, "duration": round(len(x) / sr, 2)}

    # ---- pitched content first (also used to keep melody notes out of the drum lanes)
    pitched = {}
    if mode in ("auto", "melody"):
        env_peak = float(env.max()) + 1e-9

        def onset_strength_at(t):
            fr = int(round((t - frame_offset) * fps))
            lo, hi = max(0, fr - 3), min(len(env), fr + 4)
            return float(env[lo:hi].max()) if hi > lo else 0.0

        for kind, (band, fmin, fmax, chan, attack_gate) in {
            #  kind:  (band-pass,            fmin,  fmax,   midi chan, min attack)
            "bass":   ((30.0, 320.0),        35.0,  220.0,  1, 0.10),
            "melody": ((200.0, 2600.0),      180.0, 1100.0, 2, 0.12),
        }.items():
            y = bp(x, band[0], band[1], sr, 4)
            times, freqs, confs, loud = yin_track(y, sr, fmin=fmin, fmax=fmax)
            seg = segments_to_notes(times, freqs, confs, loud,
                                    min_dur=0.080 if kind == "bass" else 0.065)
            seg = [s_ for s_ in seg if onset_strength_at(s_["t0"]) >= attack_gate]
            seg = merge_adjacent(seg, gap_s=step_s * 0.75)
            seg = [s_ for s_ in seg if (s_["t1"] - s_["t0"]) >= 0.055]
            seg = dedupe(seg, step_s)
            notes = []
            for s_ in sorted(seg, key=lambda n: n["t0"]):
                t0 = quantize_time(s_["t0"], offset, step_s, quant)
                t1 = quantize_time(s_["t1"], offset, step_s, quant)
                t1 = max(t1, t0 + step_s * 0.9)
                v = int(np.clip(55 + s_["conf"] * 65, 45, 120))
                notes.append((max(0.0, t0), s_["midi"], max(step_s * 0.4, t1 - t0), v))
            if notes:
                pitched[kind] = notes
                tracks.append((kind.title(), chan, notes))
                stats["notes"] += len(notes)

    # ---- drums
    if mode in ("auto", "drums"):
        melodic_times = [t for kind in pitched.values() for (t, _p, _d, _v) in kind]
        hits = detect_drums(x, sr, env, fps, sens, frame_offset, bands, melodic_times)
        stats["onsets"] = len(hits)
        lane_notes = {}
        for h in hits:
            t = quantize_time(h["time"], offset, step_s, quant)
            if t < 0:
                continue
            step = int(round((t - offset) / step_s))
            lane_notes.setdefault(h["lane"], {})[step] = h["vel"]
        for lane in ("kick", "snare", "clap", "hh_closed", "hh_open"):
            if lane not in lane_notes:
                continue
            notes, seen = [], set()
            for step in sorted(lane_notes[lane]):
                if step < 0 or step in seen:
                    continue
                seen.add(step)
                v = lane_notes[lane][step]
                notes.append((step * step_s + offset, GM[lane], step_s * 0.45,
                              int(np.clip(40 + v * 87, 40, 127))))
            tracks.append((lane.replace("_", " ").title(), 9, notes))
            stats["notes"] += len(notes)

    midi = write_smf(tracks, bpm)
    # note list for the UI (steps relative to bar 1)
    ui_tracks = []
    for (tname, chan, notes) in tracks:
        is_drum = chan == 9
        ui_tracks.append({
            "name": tname,
            "kind": "drums" if is_drum else "pitched",
            "channel": chan,
            "notes": [{"step": round((t - offset) / step_s, 3),
                       "pitch": p,
                       "len": max(1.0, round(d / step_s, 2)),
                       "vel": round(v / 127.0, 3)} for (t, p, d, v) in notes],
        })
    return {"bpm": round(bpm, 3), "offset": round(offset, 4), "conf": round(conf, 3),
            "grid": grid, "stats": stats, "tracks": ui_tracks,
            "midi_b64": base64.b64encode(midi).decode("ascii")}


# --------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "Beatforge/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        sys.stderr.write("[beatforge] " + (fmt % a) + "\n")

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._send(200, json.dumps({"ok": True, "service": "beatforge"}))
        if path in ("/", "/index.html", "/beatforge.html"):
            return self._file(os.path.join(ROOT, "beatforge.html"), "text/html; charset=utf-8")
        if path.startswith("/demo/"):
            return self._demo(path)
        return self._send(404, json.dumps({"error": "not found"}))

    def _demo(self, path):
        """Serve demo audio, confined to <ROOT>/demo.

        Only the last path segment is used, so '..' cannot walk out of demo/ and reach
        the rest of the repo (server.py, .git/config, ...); the resolved path is then
        checked to really live inside demo/ before anything is read.
        """
        demo_dir = os.path.realpath(os.path.join(ROOT, "demo"))
        name = os.path.basename(unquote(path))
        target = os.path.realpath(os.path.join(demo_dir, name))
        try:
            inside = os.path.commonpath([demo_dir, target]) == demo_dir
        except ValueError:                       # different drives on Windows
            inside = False
        if (name != os.path.basename(name) or not name.lower().endswith(".wav")
                or not inside or not os.path.isfile(target)):
            return self._send(404, json.dumps({"error": "not found"}))
        return self._file(target, "audio/wav")

    def _file(self, path, ctype):
        if not os.path.isfile(path):
            return self._send(404, json.dumps({"error": "missing file: " + os.path.basename(path)}))
        with open(path, "rb") as f:
            data = f.read()
        return self._send(200, data, ctype)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/audio2midi":
            return self._send(404, json.dumps({"error": "not found"}))
        try:
            q = parse_qs(u.query)
            sr = int(float(q.get("sr", ["22050"])[0]))
            mode = q.get("mode", ["auto"])[0]
            bpm_q = q.get("bpm", ["auto"])[0]
            bpm = None if bpm_q in ("auto", "", "0") else float(bpm_q)
            sens = float(q.get("sensitivity", ["0.5"])[0])
            quant = float(q.get("quantize", ["1.0"])[0])
            grid = int(float(q.get("grid", ["16"])[0]))
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                return self._send(400, json.dumps({"error": "empty body"}))
            if length > 60 * 1024 * 1024:
                return self._send(413, json.dumps({"error": "file too large (max ~60 MB)"}))
            raw = self.rfile.read(length)
            x = np.frombuffer(raw, dtype="<f4").astype(np.float32)
            max_samples = int(MAX_SECONDS * sr)
            truncated = len(x) > max_samples
            if truncated:
                x = x[:max_samples]
            t0 = time.time()
            result = transcribe(x, sr, mode=mode, bpm_override=bpm, sens=sens,
                                quant=quant, grid=grid)
            result["stats"]["analyzed_s"] = round(time.time() - t0, 2)
            result["stats"]["truncated"] = truncated
            self._send(200, json.dumps(result))
        except Exception as e:
            traceback.print_exc()
            self._send(500, json.dumps({"error": str(e)}))


def main():
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"BEATFORGE running on http://{host}:{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
