// ---- richer shim: canvas 2d context + WAV-decoding AudioContext ----
require("./shim.cjs");
const fs = require("fs");
function readWavMono(buf){
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let pos = 12, fmt = null, data = null;
  while (pos < b.length - 8){
    const id = b.toString("ascii", pos, pos + 4), sz = b.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { channels: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12) };
    if (id === "data") data = b.subarray(pos + 8, pos + 8 + sz);
    pos += 8 + sz + (sz % 2);
  }
  const n = data.length / 2 / fmt.channels;
  const chans = [];
  for (let c = 0; c < fmt.channels; c++){
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    chans.push(arr);
  }
  return { channels: chans, sr: fmt.sr, sampleRate: fmt.sr, length: n, numberOfChannels: fmt.channels,
           getChannelData: c => chans[c] };
}
const ctx2d = { setTransform(){}, clearRect(){}, fillRect(){}, beginPath(){}, moveTo(){}, lineTo(){},
  stroke(){}, fill(){}, fillText(){}, save(){}, restore(){}, set fillStyle(v){}, set strokeStyle(v){},
  set lineWidth(v){}, set font(v){} };
global.window.AudioContext = function(){
  this.sampleRate = 44100; this.currentTime = 0; this.state = "running"; this.resume = () => {};
  this.destination = {};
  this.decodeAudioData = (buf, ok) => Promise.resolve(readWavMono(Buffer.from(buf)));
  const node = () => ({ connect(){}, start(){}, stop(){}, gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},
    frequency:{value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}}, Q:{value:0}, buffer:null,
    curve:null, oversample:"", threshold:{value:0}, ratio:{value:0}, attack:{value:0}, release:{value:0} });
  this.createGain = node; this.createOscillator = node; this.createBiquadFilter = node;
  this.createBufferSource = node; this.createConvolver = node; this.createWaveShaper = node;
  this.createDynamicsCompressor = node;
  this.createBuffer = (c,l) => ({ getChannelData: () => new Float32Array(l) });
};
// canvas support
const origQS = global.document.querySelector;
global.document.querySelector = s => {
  const el = origQS(s);
  if (s === "#timeline"){ el.getContext = () => ctx2d; el.clientWidth = 900; }
  return el;
};
global.performance = { now: () => Date.now() };

const fs2 = require("fs");
const code = fs2.readFileSync("../build/app.js","utf8") + "\n;module.exports={transcribeFile,state,localTranscribe,buildSMF};";
const m = new module.constructor();
m._compile(code, "/tmp/full.js");
const api = m.exports;

// user choices: in-browser engine, drums mode
api.state.tracks.kick.steps.set(0,{vel:1,pitch:0,len:1});   // prove the sequencer half also works
const qs = global.document.querySelector;
qs("#engine").value = "browser";
qs("#mode").value = "drums";
qs("#a2mGrid").value = "16";
qs("#sens").value = "0.5";
qs("#quant").value = "1";
qs("#a2mBpm").value = "auto";

// Path is relative to this file so the suite runs from any clone or working directory.
const wav = fs2.readFileSync(require("path").join(__dirname, "..", "demo", "drums.wav"));
const file = { name:"drums.wav", arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) };

(async () => {
  await api.transcribeFile(file);
  const res = api.state.lastResult;
  if (!res) { console.log("FAIL: no result");
    console.log("  status:", qs("#status").textContent);
    console.log("  warn  :", qs("#a2mWarn").textContent);
    process.exit(1); }
  console.log("engine used      :", res.engine_used);
  console.log("bpm              :", res.bpm);
  console.log("tracks           :", res.tracks.map(t => `${t.name}(${t.notes.length})`).join(" "));
  console.log("stats            :", JSON.stringify(res.stats));
  console.log("midi bytes       :", res.bytes ? res.bytes.length : "missing");
  console.log("midi_b64 present :", typeof res.midi_b64 === "string" && res.midi_b64.length > 20);
  fs2.writeFileSync("/tmp/browser_engine.mid", Buffer.from(res.bytes));
  console.log("status text      :", qs("#status").textContent);
  console.log("warn text        :", qs("#a2mWarn").textContent.slice(0, 80) + "…");
  console.log("\nsequencer still intact (independent of transcription):",
    api.state.tracks.kick.steps.size, "kick step programmed");
})().catch(e => { console.log("FAIL:", e.message, "\n", e.stack.split("\n").slice(0,4).join("\n")); process.exit(1); });
