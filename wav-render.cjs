require("./shim.cjs");
const fs = require("fs");
// --- OfflineAudioContext shim: records scheduled notes and synthesises a real buffer,
//     so the render path + WAV encoder can be verified end to end ---
const scheduled = [];
function FakeParam(v){ this.value = v; }
FakeParam.prototype.setValueAtTime = function(){};
FakeParam.prototype.linearRampToValueAtTime = function(){};
FakeParam.prototype.exponentialRampToValueAtTime = function(){};
function FakeNode(kind, off){
  this.kind = kind; this._off = off;
  this.gain = new FakeParam(1); this.frequency = new FakeParam(0); this.Q = new FakeParam(1);
  this.threshold = new FakeParam(0); this.ratio = new FakeParam(0);
  this.attack = new FakeParam(0); this.release = new FakeParam(0);
  this.connect = function(){ return arguments[0]; };
}
FakeNode.prototype.start = function(t){ if (this._off) scheduled.push({ kind: this.kind, t }); };
FakeNode.prototype.stop = function(){};
global.OfflineAudioContext = function(ch, len, sr){
  this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.destination = {};
  const self = this;
  const mk = k => new FakeNode(k, true);
  this.createGain = () => mk("gain");
  this.createWaveShaper = () => mk("shaper");
  this.createDynamicsCompressor = () => mk("comp");
  this.createConvolver = () => mk("conv");
  this.createBiquadFilter = () => mk("biquad");
  this.createBufferSource = () => mk("source");
  this.createOscillator = () => mk("osc");
  this.createBuffer = (c, l) => ({ getChannelData: () => new Float32Array(l), numberOfChannels: c, length: l, sampleRate: sr });
  this.startRendering = async () => {
    // synthesise something musical so the encoder has real content to write
    const L = new Float32Array(len), R = new Float32Array(len);
    for (const ev of scheduled){
      const i0 = Math.floor(ev.t * sr);
      for (let i = 0; i < sr * 0.12 && i0 + i < len; i++){
        const env = Math.exp(-i / (sr * 0.03));
        const v = Math.sin(2 * Math.PI * 110 * i / sr) * env * 0.6;
        L[i0 + i] += v; R[i0 + i] += v * 0.97;
      }
    }
    const chans = [L, R];
    return { numberOfChannels: 2, length: len, sampleRate: sr, getChannelData: c => chans[c], duration: len / sr };
  };
};

const code = fs.readFileSync("../build/app.js","utf8") + "\n;module.exports={state,renderPatternBuffer,encodeWav,GENRES,loadPreset,TRACK_DEFS,totalSteps,buildSMF};";
const m = new module.constructor(); m._compile(code, "/tmp/wavt.js");
const api = m.exports;
global.document.querySelector("#vol").value = "0.85";
global.document.querySelector("#wavLoops").value = "2";
global.document.querySelector("#bpm").value = "140";
// load a genre the way the UI does
api.loadPreset("trap");
const noteCount = Object.values(api.state.tracks).reduce((s, t) => s + t.steps.size, 0);
console.log("programmed notes:", noteCount, "| bars:", api.state.bars, "| steps:", api.totalSteps());

let failures = 0;
function check(label, ok, detail){
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

(async () => {
  const t0 = Date.now();
  const LOOPS = 2, TAIL = 2.0;
  const buf = await api.renderPatternBuffer(LOOPS, TAIL);
  console.log(`renderPatternBuffer -> ${buf.duration.toFixed(2)}s of ${buf.sampleRate} Hz stereo (${Date.now()-t0} ms)`);

  // the render must be exactly as long as the maths says it should be
  const expected = api.state.bars * LOOPS * 16 * (60 / api.state.bpm / 4) + TAIL;
  check("sample rate is 44100", buf.sampleRate === 44100, buf.sampleRate);
  check("render is stereo", buf.numberOfChannels === 2, buf.numberOfChannels);
  check("duration matches bars x loops + tail", Math.abs(buf.duration - expected) < 0.05,
        `${buf.duration.toFixed(3)}s vs ${expected.toFixed(3)}s expected`);
  check("voices were actually scheduled", scheduled.length > 0, scheduled.length + " events");

  // The float buffer is pre-master: encodeWav normalises it, so a peak above 1.0 here is
  // expected (and it's what proves the normalisation below is doing real work).
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let floatPeak = 0; for (let i = 0; i < L.length; i++) floatPeak = Math.max(floatPeak, Math.abs(L[i]));
  check("left channel carries signal", floatPeak > 0.01, "peak " + floatPeak.toFixed(3));
  let rightPeak = 0; for (let i = 0; i < R.length; i++) rightPeak = Math.max(rightPeak, Math.abs(R[i]));
  check("right channel carries signal", rightPeak > 0.01, "peak " + rightPeak.toFixed(3));

  const wav = new Uint8Array(api.encodeWav(buf, 0.95));
  fs.writeFileSync("/tmp/pattern.wav", Buffer.from(wav));

  // and the file must be a structurally valid 16-bit PCM WAV
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = n => String.fromCharCode(wav[n], wav[n+1], wav[n+2], wav[n+3]);
  check("RIFF/WAVE header", tag(0) === "RIFF" && tag(8) === "WAVE");
  check("fmt chunk is 16-bit PCM stereo", dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 2 && dv.getUint16(34, true) === 16);
  check("fmt sample rate matches the buffer", dv.getUint32(24, true) === buf.sampleRate, dv.getUint32(24, true));
  check("data chunk is present", tag(36) === "data");
  check("byte length matches the header fields", wav.length === 44 + buf.length * 2 * 2, wav.length + " bytes");
  check("RIFF size field is correct", dv.getUint32(4, true) === wav.length - 8);
  check("data size field is correct", dv.getUint32(40, true) === buf.length * 2 * 2);

  // encodeWav normalises to the requested level: the written int16s must peak at
  // exactly 0.95 full scale, and must never wrap around or clip past it.
  let intPeak = 0, over = 0;
  for (let i = 0; i < buf.length * 2; i++){
    const v = Math.abs(dv.getInt16(44 + i * 2, true));
    if (v > intPeak) intPeak = v;
    if (v > 32767 * 0.95 + 1) over++;
  }
  check("normalised to 0.95 full scale", Math.abs(intPeak - 32767 * 0.95) <= 2,
        "peak sample " + intPeak + " (target " + Math.round(32767 * 0.95) + ")");
  check("nothing clips or wraps", over === 0, over + " over-level samples");

  console.log(`WAV bytes: ${wav.length} | scheduled voice events: ${scheduled.length}`);
  console.log(failures ? `\n${failures} WAV RENDER CHECK(S) FAILED` : "\nWAV RENDER VERIFIED");
  if (failures) process.exit(1);
})().catch(e => { console.log("FAIL:", e.message, "\n", e.stack.split("\n").slice(0,4).join("\n")); process.exit(1); });
