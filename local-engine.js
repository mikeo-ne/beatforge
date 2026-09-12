/* ======================================================================
   8b. IN-BROWSER ANALYSER
   A JavaScript port of the server-side transcriber, so audio -> MIDI works
   with no backend at all: no install, no upload. Slightly less accurate than
   the numpy version (smaller FFTs, coarser pitch search) but fully standalone.
   ====================================================================== */

/* --- iterative radix-2 FFT (in place) --- */
function fftInPlace(re, im){
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++){
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j){
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1){
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len){
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++){
        const a = i + k, b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function hannWindow(n){
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}
function localMean(a, win){
  const n = a.length, out = new Float32Array(n), half = win >> 1;
  let sum = 0;
  const at = i => a[Math.max(0, Math.min(n - 1, i))];
  for (let i = -half; i <= half; i++) sum += at(i);
  for (let i = 0; i < n; i++){
    out[i] = sum / win;
    sum -= at(i - half);
    sum += at(i + half + 1);
  }
  return out;
}

/* --- stage 1: spectral analysis -> band energies + per-band flux --- */
function analyseBands(x, sr, onProgress){
  const NFFT = 1024, HOP = 220;
  const win = hannWindow(NFFT);
  const nFrames = Math.max(2, Math.floor((x.length - NFFT) / HOP) + 1);
  const binHz = sr / NFFT;
  const iSubEnd = Math.max(1, Math.floor(140 / binHz));          // sub: f < 140
  const iLowEnd = Math.floor(350 / binHz);                       // low body: 140-350
  const iMidEnd = Math.min(NFFT / 2, Math.floor(3000 / binHz));  // mid: 350-3000
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  const eSub = new Float32Array(nFrames), eLow = new Float32Array(nFrames);
  const eMid = new Float32Array(nFrames), eHigh = new Float32Array(nFrames);
  const fSub = new Float32Array(nFrames), fMid = new Float32Array(nFrames), fHigh = new Float32Array(nFrames);
  const nSub = iSubEnd, nLow = Math.max(1, iLowEnd - iSubEnd), nMid = Math.max(1, iMidEnd - iLowEnd),
        nHigh = Math.max(1, NFFT / 2 - iMidEnd);
  let prevSub = new Float32Array(nSub), prevMid = new Float32Array(nMid), prevHigh = new Float32Array(nHigh);
  let energySub = 0, energyMid = 0, energyHigh = 0;

  for (let f = 0; f < nFrames; f++){
    const off = f * HOP;
    for (let i = 0; i < NFFT; i++){ re[i] = x[off + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    let sSub = 0, sLow = 0, sMid = 0, sHigh = 0;
    let flSub = 0, flMid = 0, flHigh = 0;
    for (let i = 0; i <= NFFT / 2; i++){
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      if (i < iSubEnd){
        sSub += mag;
        const lg = Math.log1p(mag * 40);
        const d = lg - prevSub[i]; if (d > 0) flSub += d;
        prevSub[i] = lg;
      } else if (i < iLowEnd){
        sLow += mag;
      } else if (i < iMidEnd){
        sMid += mag; energyMid += mag;
        const lg = Math.log1p(mag * 40);
        const d = lg - prevMid[i - iLowEnd]; if (d > 0) flMid += d;
        prevMid[i - iLowEnd] = lg;
      } else {
        sHigh += mag; energyHigh += mag;
        const lg = Math.log1p(mag * 40);
        const d = lg - prevHigh[i - iMidEnd]; if (d > 0) flHigh += d;
        prevHigh[i - iMidEnd] = lg;
      }
    }
    // per-BIN mean magnitudes: summing over bins would let the wide high band
    // (hundreds of bins) swamp the narrow sub band and hide every kick
    energySub += sSub / nSub;
    eSub[f] = sSub / nSub; eLow[f] = sLow / nLow; eMid[f] = sMid / nMid; eHigh[f] = sHigh / nHigh;
    fSub[f] = flSub / nSub; fMid[f] = flMid / nMid; fHigh[f] = flHigh / nHigh;
    if (onProgress && (f & 511) === 0) onProgress(f / nFrames);
  }

  // silence gate: a band only counts if it carries a real share of the energy
  const tot = energySub + energyMid + energyHigh + 1e-12;
  const present = { sub: energySub / tot > 0.005, mid: energyMid / tot > 0.005, high: energyHigh / tot > 0.005 };
  const means = [];
  if (present.sub) means.push(mean(fSub)); if (present.mid) means.push(mean(fMid)); if (present.high) means.push(mean(fHigh));
  const floor = 0.20 * (means.reduce((a, b) => a + b, 0) / Math.max(1, means.length) + 1e-9);
  const env = new Float32Array(nFrames);
  const normF = {};
  ["sub", "mid", "high"].forEach(k => {
    const arr = k === "sub" ? fSub : k === "mid" ? fMid : fHigh;
    if (!present[k]){ normF[k] = new Float32Array(nFrames); return; }
    const mu = Math.max(mean(arr), floor);
    const out = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++){ out[i] = arr[i] / mu; env[i] += out[i]; }
    normF[k] = out;
  });
  // light smoothing
  const sm = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++){
    sm[i] = 0.2 * env[Math.max(0, i - 1)] + 0.6 * env[i] + 0.2 * env[Math.min(nFrames - 1, i + 1)];
  }
  let mx = 0; for (let i = 0; i < nFrames; i++) mx = Math.max(mx, sm[i]);
  if (mx > 0) for (let i = 0; i < nFrames; i++) sm[i] /= mx;
  return { env: sm, present, eSub, eLow, eMid, eHigh, flux: normF,
           fps: sr / HOP, frameOffset: (NFFT / 2) / sr };
}
function mean(a){ let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }

/* --- stage 2: onset peak picking --- */
function pickPeaksLocal(env, fps, sensitivity, minGapSec, floorRatio){
  const n = env.length, out = [];
  if (n < 6) return out;
  const win = Math.max(3, (Math.round(0.45 * fps) | 1));
  const lm = localMean(env, win);
  const k = 0.55 - 0.45 * sensitivity;
  let floor = 0.012 + 0.05 * (1 - sensitivity);
  if (floorRatio > 0){
    const sorted = Array.prototype.slice.call(env).sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    floor = Math.max(floor, floorRatio * p90);
  }
  const gap = Math.max(1, Math.round((minGapSec || 0.045) * fps));
  const look = Math.max(1, Math.round(0.05 * fps));
  let i = 1;
  while (i < n - 1){
    const thr = Math.max(lm[i] * (1 + k), floor);
    if (env[i] > thr && env[i] >= env[i - 1] && env[i] >= env[i + 1]){
      let best = true;
      for (let j = Math.max(0, i - look); j < Math.min(n, i + look); j++){
        if (env[j] > env[i] + 1e-9){ best = false; break; }
      }
      if (best){ out.push(i); i += gap; continue; }
    }
    i++;
  }
  return out;
}

/* --- stage 3: tempo + grid phase --- */
function detectTempoLocal(env, fps, frameOffset, lo, hi){
  lo = lo || 60; hi = hi || 190;
  const n = env.length;
  let mu = mean(env);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = env[i] - mu;
  let v0 = 0; for (let i = 0; i < n; i++) v0 += e[i] * e[i];
  if (v0 <= 0) return { bpm: 120, offset: 0, conf: 0 };
  const minLag = Math.max(1, Math.round(fps * 60 / hi));
  const maxLag = Math.min(n - 2, Math.round(fps * 60 / lo));
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++){
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
    ac[lag] = s / v0;
  }
  let bestLag = minLag, bestScore = -1e9;
  const scores = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++){
    let sc = ac[lag];
    for (const m of [2, 3, 4]) if (lag * m <= maxLag) sc += (0.5 / m) * ac[lag * m];
    const bpmL = 60 * fps / lag;
    sc *= 1 + 0.12 * Math.exp(-Math.pow((bpmL - 120) / 60, 2));
    scores[lag] = sc;
    if (sc > bestScore){ bestScore = sc; bestLag = lag; }
  }
  const coarse = 60 * fps / bestLag;
  // confidence
  let m2 = 0, m1 = 0, cnt = 0;
  for (let i = minLag; i <= maxLag; i++){ m1 += scores[i]; cnt++; }
  m1 /= cnt;
  for (let i = minLag; i <= maxLag; i++) m2 += (scores[i] - m1) * (scores[i] - m1);
  const sd = Math.sqrt(m2 / cnt);
  const conf = Math.max(0, Math.min(1, ((bestScore - m1) / (sd + 1e-9)) / 6));

  const acfAt = b => { const i = Math.round(60 * fps / b); return (i >= 1 && i <= maxLag) ? ac[i] : -1; };
  const gridEnergy = (b, div) => {
    const stepP = (60 / b) / (div || 4);
    let best = -1;
    for (let ph = 0; ph < stepP; ph += stepP / 6){
      const count = Math.floor((n / fps - ph) / stepP) + 1;
      if (count < 8) continue;
      let sum = 0, used = 0;
      for (let k = 0; k < count; k++){
        const idx = Math.round((ph + k * stepP - frameOffset) * fps);
        if (idx < 0 || idx >= n) continue;
        let v = 0;
        for (let j = Math.max(0, idx - 2); j < Math.min(n, idx + 3); j++) v = Math.max(v, env[j]);
        sum += v; used++;
      }
      if (used >= 8) best = Math.max(best, sum / used);
    }
    return best;
  };
  const refine = (b0) => {
    let bb = b0, bv = gridEnergy(b0);
    for (const step of [0.004, 0.0012]){
      const c0 = bb * (1 - 3 * step), c1 = bb * (1 + 3 * step), dc = bb * step;
      for (let c = c0; c <= c1; c += dc){
        const v = gridEnergy(c);
        if (v > bv){ bv = v; bb = c; }
      }
    }
    return [bb, bv];
  };
  const prior = b => (b < 65 || b > 200) ? -1 : Math.exp(-Math.pow(Math.log2(b / 118) / 0.42, 2));
  const phaseCoh = (b) => {
    const stepP = (60 / b) / 4;
    const peaks = pickPeaksLocal(env, fps, 0.5);
    if (peaks.length < 4) return 0;
    const t0 = peaks[0] / fps + frameOffset;
    let num = 0, den = 0;
    peaks.forEach(p => {
      const t = p / fps + frameOffset;
      const resid = Math.abs((((t - (t0 % stepP)) / stepP) % 1 + 1) % 1);
      num += env[p] * Math.cos(2 * Math.PI * Math.min(resid, 1 - resid));
      den += env[p];
    });
    return den > 0 ? num / den : 0;
  };
  let bestB = coarse, bestS = -1e9;
  for (const m of [0.5, 1, 2]){
    const b = coarse * m;
    if (b < lo || b > hi) continue;
    const [br, fit] = refine(b);
    const sc = 0.45 * acfAt(br) + 1.10 * prior(br) + 0.30 * phaseCoh(br) + 0.25 * fit;
    if (sc > bestS){ bestS = sc; bestB = br; }
  }
  // phase = circular mean of onset phases
  const step = (60 / bestB) / 4;
  const peaks = pickPeaksLocal(env, fps, 0.5);
  let off = 0;
  if (peaks.length >= 3){
    let c = 0, s = 0;
    peaks.forEach(p => {
      const t = p / fps + frameOffset;
      const ph = ((t % step) / step) * 2 * Math.PI;
      c += env[p] * Math.cos(ph); s += env[p] * Math.sin(ph);
    });
    if (Math.abs(c) > 1e-9 || Math.abs(s) > 1e-9){
      off = (Math.atan2(s, c) / (2 * Math.PI)) * step;
      while (off > step * 0.5) off -= step;
      off = Math.max(0, off);
    }
  }
  return { bpm: bestB, offset: off, conf };
}

function bandWinMean(arr, a, b){
  let s = 0, c = 0;
  for (let i = Math.max(0, a); i < Math.min(arr.length, b); i++){ s += arr[i]; c++; }
  return c ? s / c : 0;
}
function attackRatioLocal(an, frame, band){
  const arr = band === "sub" ? an.eSub : band === "mid" ? an.eMid : an.eHigh;
  const pre = bandWinMean(arr, frame - 6, frame - 1);
  const atk = bandWinMean(arr, frame, frame + 9);
  return (atk - pre) / (atk + 1e-12);
}

/* --- stage 4: drum lane classification (from band energies, baseline subtracted) --- */
function classifyAt(an, frame, sr){
  const fps = an.fps, n = an.env.length;
  const atk = (arr, a, b) => { let s = 0, c = 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++){ s += arr[i]; c++; } return c ? s / c : 0; };
  const p = frame;
  const aSub = atk(an.eSub, p, p + 3), aLow = atk(an.eLow, p, p + 3),
        aMid = atk(an.eMid, p, p + 3), aHigh = atk(an.eHigh, p, p + 3);
  const bSub = atk(an.eSub, p - 6, p - 1), bMid = atk(an.eMid, p - 6, p - 1), bHigh = atk(an.eHigh, p - 6, p - 1);
  const dSub = Math.max(0, aSub - bSub), dMid = Math.max(0, aMid - bMid), dHigh = Math.max(0, aHigh - bHigh);
  const tot = dSub + dMid + dHigh + 1e-12;
  const shSub = dSub / tot, shMid = dMid / tot, shHigh = dHigh / tot;
  // decay: how much of the high band's attack survives 40-180 ms later
  const tailHigh = Math.max(0, atk(an.eHigh, p + 5, p + 14) - bHigh);
  const decayHigh = tailHigh / (dHigh + 1e-12);
  const lowBody = Math.max(0, aLow - atk(an.eLow, p - 6, p - 1));
  const strongest = Math.max(shSub, shMid, shHigh);
  const out = [];
  const LMIN = { kick: 0.45, hh: 0.45, clap: 0.60 };
  const primary = shSub >= shMid && shSub >= shHigh ? "kick" : (shHigh >= shMid ? "hh" : "clap");
  const push = (lane, v) => out.push([lane, Math.max(0.4, Math.min(1, 0.45 + 0.5 * v))]);
  if ((shSub >= LMIN.kick || primary === "kick") && shSub >= 0.30) push("kick", shSub);
  if ((shHigh >= LMIN.hh || primary === "hh") && shHigh >= 0.30){
    push(decayHigh > 0.34 ? "hh_open" : "hh_closed", shHigh);
  }
  if ((shMid >= LMIN.clap || primary === "clap") && shMid >= 0.30 && primary !== "kick"){
    push(lowBody > 0.55 * Math.max(aMid, 1e-12) ? "snare" : "clap", shMid);
  }
  if (!out.length) push("hh_closed", 0.4);
  return out;
}

/* --- simple RBJ biquad filters: the server band-limits each lane before pitch
   tracking, and without that the 808's harmonics and the pad hijack the melody --- */
function biquad(x, f0, Q, type){
  const w0 = 2 * Math.PI * f0 / this.sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0, b1, b2;
  if (type === "low"){ b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++){
    const xn = x[i];
    const yn = (b0 / a0) * xn + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = xn; y2 = y1; y1 = yn;
    out[i] = yn;
  }
  return out;
}
function bandLimit(x, sr, fLow, fHigh){
  const ctxf = { sr };
  let y = x;
  if (fHigh) y = biquad.call(ctxf, y, fHigh, 0.707, "low");
  if (fLow){
    y = biquad.call(ctxf, y, fLow, 0.707, "high");
    y = biquad.call(ctxf, y, fLow, 0.707, "high");
  }
  return y;
}

/* --- stage 5: YIN pitch tracking, one lane at a time (band-limited first) --- */
function trackPitches(x, sr, onProgress, lane){
  const N = 2048, HOP = 256;
  const nFrames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const re = new Float32Array(N), im = new Float32Array(N);
  const bassM = new Float32Array(nFrames), bassC = new Float32Array(nFrames);
  const melM = new Float32Array(nFrames), melC = new Float32Array(nFrames);
  const loud = new Float32Array(nFrames);
  const isBass = lane !== "melody";
  const tauBassMin = Math.max(2, Math.floor(sr / 220)), tauBassMax = Math.min(N - 2, Math.floor(sr / 35));
  const tauMelMin = Math.max(2, Math.floor(sr / 1100)), tauMelMax = Math.min(N - 2, Math.floor(sr / 180));
  const cmnd = new Float32Array(Math.max(tauBassMax, tauMelMax) + 2);
  const acf = new Float32Array(N);
  for (let f = 0; f < nFrames; f++){
    const off = f * HOP;
    let m = 0;
    for (let i = 0; i < N; i++) m += x[off + i];
    m /= N;
    let p0 = 0;
    for (let i = 0; i < N; i++){ const v = x[off + i] - m; re[i] = v; im[i] = 0; p0 += v * v; }
    loud[f] = Math.sqrt(p0 / N);
    if (p0 < 1e-9) continue;
    fftInPlace(re, im);
    for (let i = 0; i < N; i++){ const a = re[i], b = im[i]; re[i] = a * a + b * b; im[i] = 0; }
    // inverse FFT (conjugate trick): conj -> forward -> conj -> /N
    for (let i = 0; i < N; i++) im[i] = -im[i];
    fftInPlace(re, im);
    for (let i = 0; i < N; i++) acf[i] = re[i] / N;
    let run = 0;
    const tmax = Math.max(tauBassMax, tauMelMax);
    for (let tau = 0; tau <= tmax + 1; tau++){
      const d = 2 * (p0 - acf[tau]);
      run += d;
      cmnd[tau] = tau === 0 ? 1 : (d * tau) / (run + 1e-12);
    }
    const pick = (tmin, tmax2) => {
      let tau = -1;
      for (let t = tmin; t < tmax2; t++){
        if (cmnd[t] < 0.16 && cmnd[t] <= cmnd[t + 1]){ tau = t; break; }
      }
      if (tau < 0){
        let bv = 1e9;
        for (let t = tmin; t <= tmax2; t++) if (cmnd[t] < bv){ bv = cmnd[t]; tau = t; }
        if (cmnd[tau] > 0.45) return [0, 0];
      }
      if (tau > 0 && tau < tmax + 1){
        const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
        const den = a - 2 * b + c;
        if (Math.abs(den) > 1e-12) tau = tau + 0.5 * (a - c) / den;
      }
      const f0 = sr / tau;
      return [f0, Math.max(0, Math.min(1, 1 - cmnd[Math.round(tau)]))];
    };
    if (isBass){
      const [fb, cb] = pick(tauBassMin, tauBassMax);
      if (fb >= 30 && fb <= 250){ bassM[f] = fb; bassC[f] = cb; }
    } else {
      const [fm, cm] = pick(tauMelMin, tauMelMax);
      if (fm >= 160 && fm <= 1200){ melM[f] = fm; melC[f] = cm; }
    }
    if (onProgress && (f & 255) === 0) onProgress(f / nFrames);
  }
  return { hop: HOP, sr, bassM, bassC, melM, melC, loud };
}

/* --- stage 6: frames -> notes --- */
function framesToNotes(track, which){
  const { hop, sr } = track;
  const fr = which === "bass" ? track.bassM : track.melM;
  const cf = which === "bass" ? track.bassC : track.melC;
  const minF = which === "bass" ? 35 : 180, maxF = which === "bass" ? 220 : 1100;
  // the 808 glides for ~35 ms, so the bass lane needs a longer settle window
  // before its pitch is measured; a shorter one reads the glide, not the note
  const settle = which === "bass" ? 0.055 : 0.022;
  const minDur = which === "bass" ? 0.090 : 0.065;
  const segs = [];
  let cur = null;
  const closeSeg = () => {
    if (!cur) return;
    const dur = cur.tEnd - cur.t0;
    if (dur >= minDur && cur.vals.length){
      const keep = cur.vals.map((v, i) => [v, cur.w[i], cur.t[i]]).filter(x => x[2] - cur.t0 >= settle);
      const use = keep.length ? keep : cur.vals.map((v, i) => [v, cur.w[i], cur.t[i]]);
      use.sort((a, b) => a[0] - b[0]);
      let totW = 0; use.forEach(u => totW += u[1]);
      let acc = 0, med = use[use.length - 1][0];
      for (const u of use){ acc += u[1]; if (acc >= totW * 0.5){ med = u[0]; break; } }
      let dom = 0; use.forEach(u => { if (Math.abs(u[0] - med) <= 0.5) dom += u[1]; });
      dom = dom / (totW + 1e-12);
      if (dom >= 0.45) segs.push({ t0: cur.t0, t1: cur.tEnd, midi: Math.round(med), dom });
    }
    cur = null;
  };
  for (let i = 0; i < fr.length; i++){
    const f0 = fr[i], c = cf[i], t = (i * hop) / sr;
    let midi = null;
    if (f0 > 0 && c > 0.25){
      const m = Math.round(69 + 12 * Math.log2(f0 / 440));
      if (m >= 21 && m <= 108) midi = m;
    }
    if (midi === null){ closeSeg(); continue; }
    const ref = cur ? cur.vals[cur.vals.length - 1] : null;
    if (!cur || (ref !== null && Math.abs(midi - ref) > 0.75)){
      closeSeg();
      cur = { t0: t, tEnd: t, vals: [midi], w: [Math.max(1e-9, track.loud[i] * c * c)], t: [t] };
    } else {
      cur.vals.push(midi); cur.w.push(Math.max(1e-9, track.loud[i] * c * c));
      cur.t.push(t); cur.tEnd = t;
    }
  }
  closeSeg();
  // merge same-pitch dropouts, drop very short notes
  const merged = [];
  segs.sort((a, b) => a.t0 - b.t0).forEach(s => {
    const last = merged[merged.length - 1];
    if (last && last.midi === s.midi && s.t0 - last.t1 <= 0.75 * (60 / 140 / 4)) { last.t1 = Math.max(last.t1, s.t1); return; }
    merged.push({ ...s });
  });
  return merged.filter(s => s.t1 - s.t0 >= 0.055);
}

/* --- orchestrator --- */
function localTranscribe(pcm, sr, opts, buildSMFfn, onProgress){
  const t0 = performance.now ? performance.now() : Date.now();
  const mode = opts.mode || "auto", grid = opts.grid || 16;
  const sens = opts.sensitivity != null ? opts.sensitivity : 0.5;
  const quant = opts.quantize != null ? opts.quantize : 1;
  const report = (p, label) => { if (onProgress) onProgress(p, label); };

  report(0.02, "Analysing spectrum…");
  const an = analyseBands(pcm, sr, p => report(0.05 + p * 0.45, "Analysing spectrum…"));
  const fps = an.fps;

  let bpm, offset, conf;
  if (opts.bpmOverride && opts.bpmOverride > 20){
    bpm = opts.bpmOverride;
    const t = detectTempoLocal(an.env, fps, an.frameOffset);
    offset = t.offset; conf = 1;
  } else {
    const t = detectTempoLocal(an.env, fps, an.frameOffset);
    bpm = t.bpm; offset = t.offset; conf = t.conf;
  }
  const stepS = (60 / bpm) / (grid / 4);
  const barS = (60 / bpm) * 4;
  const totalBars = Math.max(1, Math.ceil((pcm.length / sr - offset) / barS));
  const tracks = [];
  const stats = { onsets: 0, notes: 0, bpm: Math.round(bpm * 100) / 100, confidence: Math.round(conf * 100) / 100,
                  bars: totalBars, duration: Math.round((pcm.length / sr) * 100) / 100,
                  engine: "browser" };

  // ---- pitched lanes first (their onsets also mask melodic hits out of the drum lanes)
  const pitchedTracks = [];
  if (mode === "auto" || mode === "melody"){
    report(0.55, "Tracking bass line…");
    const bassSig = bandLimit(pcm, sr, null, 320);                  // keep the low end
    const ptBass = trackPitches(bassSig, sr, p => report(0.55 + p * 0.18, "Tracking bass line…"), "bass");
    report(0.74, "Tracking melody…");
    const melSig = bandLimit(pcm, sr, 250, 2600);                   // drop the 808 and the air
    const ptMel = trackPitches(melSig, sr, p => report(0.74 + p * 0.18, "Tracking melody…"), "melody");
    const envAt = (t) => {
      const fr = Math.round((t - an.frameOffset) * fps);
      let v = 0;
      for (let j = Math.max(0, fr - 3); j < Math.min(an.env.length, fr + 4); j++) v = Math.max(v, an.env[j]);
      return v;
    };
    const peak = Math.max(1e-9, maxOf(an.env));
    [["Bass", "bass", 1, 0.10, ptBass], ["Melody", "melody", 2, 0.12, ptMel]].forEach(([name, which, chan, gate, pt]) => {
      const segs = framesToNotes(pt, which).filter(s => envAt(s.t0) / peak >= gate);
      const notes = [];
      const seen = new Set();
      segs.forEach(s => {
        let st = Math.round(((s.t0 - offset) / stepS)) * stepS + offset;
        if (quant < 1) st = s.t0 + (st - s.t0) * quant;
        let en = Math.round(((s.t1 - offset) / stepS)) * stepS + offset;
        if (quant < 1) en = s.t1 + (en - s.t1) * quant;
        const startStep = Math.round((st - offset) / stepS);
        if (seen.has(startStep)) return;
        seen.add(startStep);
        const len = Math.max(1, Math.round((en - st) / stepS));
        notes.push({ step: startStep, pitch: s.midi, len, vel: Math.max(0.35, Math.min(0.95, 0.45 + s.dom * 0.5)) });
      });
      notes.sort((a, b) => a.step - b.step);
      if (notes.length){
        pitchedTracks.push({ name, kind: "pitched", channel: chan, notes });
        tracks.push({ name, kind: "pitched", channel: chan, notes });
        stats.notes += notes.length;
      }
    });
  }

  // ---- drums
  if (mode === "auto" || mode === "drums"){
    report(0.93, "Classifying drum hits…");
    // Hybrid, mirroring the server engine: the combined envelope is reliable for
    // kick/clap but drops a quiet hat that lands under a loud kick, so the high band
    // is peak-picked separately and its onsets are added where no hat exists yet.
    const peaks = pickPeaksLocal(an.env, fps, sens);
    const peaksHigh = an.flux && an.flux.high
      ? pickPeaksLocal(an.flux.high, fps, sens, 0.045, 0.24) : [];
    const melodic = pitchedTracks.flatMap(t => t.notes.map(n => n.step * stepS + offset));
    const lanes = { kick: [], snare: [], clap: [], hh_closed: [], hh_open: [] };
    const used = {};
    const hatSteps = {};
    const addHit = (lane, step, vel) => {
      const key = lane + ":" + step;
      if (used[key] === undefined || vel > used[key]) used[key] = vel;
      if (lane === "hh_closed" || lane === "hh_open") hatSteps[step] = true;
    };
    const nearMelodic = t => {
      for (const mt of melodic) if (Math.abs(mt - t) < 0.030) return true;
      return false;
    };

    peaks.forEach(p => {
      const t = p / fps + an.frameOffset;
      if (t < 0) return;
      const tot = an.eSub[p] + an.eMid[p] + an.eHigh[p] + 1e-12;
      const shSub = an.eSub[p] / tot, shHigh = an.eHigh[p] / tot;
      if (!nearMelodic(t) === false && shSub > 0.45 && shHigh < 0.30) return;   // 808 note
      const step = Math.round((t - offset) / stepS);
      if (step < 0) return;
      classifyAt(an, p, sr).forEach(([lane, vel]) => {
        if (lane === "kick" && attackRatioLocal(an, p, "sub") < 0.32) return;
        if (lane === "clap" && attackRatioLocal(an, p, "mid") < 0.20) return;
        addHit(lane, step, vel);
      });
    });

    peaksHigh.forEach(p => {
      const t = p / fps + an.frameOffset;
      if (t < 0) return;
      const step = Math.round((t - offset) / stepS);
      if (step < 0 || hatSteps[step]) return;            // a hat is already recorded here
      const tot = an.eSub[p] + an.eMid[p] + an.eHigh[p] + 1e-12;
      const shHigh = an.eHigh[p] / tot;
      if (shHigh < 0.30) return;
      const tail = bandWinMean(an.eHigh, p + 5, p + 14);
      const decay = tail / (an.eHigh[p] + 1e-12);
      addHit(decay > 0.34 ? "hh_open" : "hh_closed", step,
             Math.max(0.35, Math.min(0.9, 0.45 + 0.4 * shHigh)));
    });

    stats.onsets = peaks.length + peaksHigh.length;
    const GM = { kick: [36, "Kick"], snare: [38, "Snare"], clap: [39, "Clap"],
                 hh_closed: [42, "Hh Closed"], hh_open: [46, "Hh Open"] };
    Object.keys(lanes).forEach(lane => lanes[lane] = []);
    Object.entries(used).forEach(([key, vel]) => {
      const i = key.indexOf(":");
      const lane = key.slice(0, i), step = +key.slice(i + 1);
      lanes[lane].push({ step, vel });
    });
    ["kick", "snare", "clap", "hh_closed", "hh_open"].forEach(lane => {
      const arr = lanes[lane].sort((a, b) => a.step - b.step);
      if (!arr.length) return;
      const [pitch, name] = GM[lane];
      const notes = arr.map(o => ({ step: o.step, pitch, len: 1, vel: o.vel }));
      tracks.push({ name, kind: "drums", channel: 9, notes });
      stats.notes += notes.length;
    });
  }

  // ---- render the MIDI file
  const ordered = ["Bass", "Melody", "Kick", "Snare", "Clap", "Hh Closed", "Hh Open", "Pad"];
  tracks.sort((a, b) => ordered.indexOf(a.name) - ordered.indexOf(b.name));
  const bytes = buildSMFfn(tracks, bpm, 480, grid);
  const dt = ((performance.now ? performance.now() : Date.now()) - t0) / 1000;
  stats.analyzed_s = Math.round(dt * 10) / 10;
  report(1, "Done.");
  return { bpm: Math.round(bpm * 1000) / 1000, offset: Math.round(offset * 1e4) / 1e4,
           conf: Math.round(conf * 1000) / 1000, grid, stats, tracks, bytes };
}
function maxOf(a){ let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, a[i]); return m; }
function bytesToBase64(bytes){
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk){
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}
