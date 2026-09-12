require("./shim.cjs");
const fs = require("fs");
// OfflineAudioContext stub (as in test_wav.js) so rendering can be exercised too
const scheduled = [];
function FakeParam(){ this.value = 0; }
FakeParam.prototype.setValueAtTime = function(){};
FakeParam.prototype.linearRampToValueAtTime = function(){};
FakeParam.prototype.exponentialRampToValueAtTime = function(){};
function FakeNode(off){
  this.gain = new FakeParam(); this.frequency = new FakeParam(); this.Q = new FakeParam();
  this.threshold = new FakeParam(); this.ratio = new FakeParam(); this.attack = new FakeParam(); this.release = new FakeParam();
  this.connect = () => {}; this._off = off;
}
FakeNode.prototype.start = function(t){ if (this._off) scheduled.push(t); };
FakeNode.prototype.stop = function(){};
global.OfflineAudioContext = function(ch, len, sr){
  this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.destination = {};
  const mk = () => new FakeNode(true);
  this.createGain = mk; this.createWaveShaper = mk; this.createDynamicsCompressor = mk;
  this.createConvolver = mk; this.createBiquadFilter = mk; this.createBufferSource = mk;
  this.createOscillator = mk;
  this.createBuffer = (c, l) => ({ getChannelData: () => new Float32Array(l) });
  this.startRendering = async () => {
    const L = new Float32Array(len), R = new Float32Array(len);
    scheduled.forEach(t => { const i0 = Math.floor(t * sr);
      for (let i = 0; i < sr * 0.1 && i0 + i < len; i++) L[i0+i] += Math.sin(i/20) * Math.exp(-i/(sr*0.02)) * 0.5; });
    return { numberOfChannels: 2, length: len, sampleRate: sr, getChannelData: c => (c ? R : L) };
  };
};

const code = fs.readFileSync(require("path").join(__dirname, "..", "build", "app.js"),"utf8") +
  "\n;module.exports={GENRES,loadPreset,state,TRACK_DEFS,totalSteps,buildSMF,encodeWav,renderPatternBuffer,scalePitches,SCALES};";
const m = new module.constructor(); m._compile(code, "/tmp/g.js");
const api = m.exports;

(async () => {
const keys = Object.keys(api.GENRES);
console.log(`genre library: ${keys.length} styles across ${new Set(keys.map(k=>api.GENRES[k].family)).size} families\n`);
let allOk = true;
const rows = [];
for (const k of keys){
  const g = api.GENRES[k];
  // 1. pattern validity
  let badSteps = 0, badPitch = 0, notes = 0, maxStep = -1;
  Object.entries(g.tracks).forEach(([id, arr]) => {
    const td = api.TRACK_DEFS.find(t => t.id === id);
    if (!td){ console.log(`  !! ${k}: unknown lane "${id}"`); allOk = false; return; }
    arr.forEach(item => {
      let step, pitch = null;
      if (Array.isArray(item)){ step = item[0]; if (td.type === "pitch") pitch = item[1]; }
      else step = item;
      notes++;
      if (!(step >= 0 && step < g.bars * 16)){ badSteps++; }
      if (pitch !== null && !(pitch >= 21 && pitch <= 108)) badPitch++;
      if (step > maxStep) maxStep = step;
    });
  });
  // 2. load it and export MIDI
  api.loadPreset(k);
  const populated = api.TRACK_DEFS.filter(td => api.state.tracks[td.id].steps.size > 0);
  const exportTracks = populated.map(td => ({
    name: td.name, channel: td.type === "drum" ? 9 : 2,
    notes: [...api.state.tracks[td.id].steps.entries()].map(([step, n]) => ({
      step, pitch: td.type === "drum" ? 36 : n.pitch, len: n.len || 1, vel: n.vel })),
  }));
  const smf = api.buildSMF(exportTracks, api.state.bpm, 480, 16);
  const valid = smf[0] === 0x4D && smf[1] === 0x54 && smf[2] === 0x68 && smf[3] === 0x64;
  const bars = api.state.bars, bpm = api.state.bpm, swing = api.state.swing;
  rows.push({ k, name:g.name, family:g.family, bpm, bars, swing, lanes:populated.length, notes,
              smf:smf.length, valid, badSteps, badPitch });
  if (!valid || badSteps || badPitch || !populated.length) allOk = false;
  // 3. render a WAV for one genre of each family, to exercise the audio path
  if (["trap","house","amapiano","pop"].includes(k)){
    const buf = await api.renderPatternBuffer(1, 1.0);
    const wav = api.encodeWav(buf, 0.95);
    console.log(`  rendered ${g.name.padEnd(16)} -> ${(buf.length/buf.sampleRate).toFixed(1)}s WAV, ${wav.length} bytes, ${scheduled.length} voices`);
    scheduled.length = 0;
  }
}
console.log("");
console.log("genre               bpm  bars swing lanes notes   smf  ok");
for (const r of rows){
  console.log(`${r.name.padEnd(18)} ${String(r.bpm).padStart(4)} ${String(r.bars).padStart(4)} ${r.swing.toFixed(2).padStart(5)} ` +
              `${String(r.lanes).padStart(5)} ${String(r.notes).padStart(5)} ${String(r.smf).padStart(5)}  ${r.valid && !r.badSteps && !r.badPitch ? "✓" : "✗"}`);
}
console.log(`\n${allOk ? "ALL GENRES VALID" : "SOME GENRES FAILED"}`);
if (!allOk) process.exit(1);

})().catch(e => { console.log("FAIL:", e.message); process.exit(1); });
