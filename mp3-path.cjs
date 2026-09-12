require("./shim.cjs");
const fs = require("fs");
// ---- mock WebCodecs, recording what it receives so the plumbing can be checked ----
const seen = { planes: [], frames: 0, chunks: 0 };
global.AudioData = function(init){
  seen.frames += init.numberOfFrames;
  // verify planar layout: first half must be L, second half R
  const half = init.numberOfFrames;
  seen.planes.push([init.data[0], init.data[half], init.format, init.numberOfChannels]);
  this.close = () => {};
};
global.AudioEncoder = function(opts){
  this._opts = opts;
  this.configure = cfg => { this._cfg = cfg; };
  this.encode = ad => {
    // emit a fake "MP3 frame" of 417 bytes (128kbps @44.1k, 1152 samples)
    seen.chunks++;
    const fake = new Uint8Array(417);
    fake[0] = 0xFF; fake[1] = 0xFB;         // MPEG-1 Layer III sync word
    opts.output({ byteLength: fake.length, copyTo: b => b.set(fake) });
  };
  this.flush = async () => {};
};
global.AudioEncoder.isConfigSupported = async cfg => ({ supported: cfg.codec === "mp3" });

const m = new module.constructor();
m._compile(fs.readFileSync("../build/app.js","utf8") + "\n;module.exports={encodeMp3};", "/tmp/m3.js");
const { encodeMp3 } = m.exports;

// a 1 second stereo buffer with distinguishable channels
const sr = 44100, len = sr;
const L = new Float32Array(len), R = new Float32Array(len);
for (let i = 0; i < len; i++){ L[i] = Math.sin(2*Math.PI*220*i/sr) * 0.5; R[i] = Math.sin(2*Math.PI*330*i/sr) * 0.4; }
const buf = { sampleRate: sr, numberOfChannels: 2, length: len, getChannelData: c => (c === 0 ? L : R) };

(async () => {
  const mp3 = await encodeMp3(buf, 192000);
  console.log(`MP3 path: ${seen.chunks} encoder calls, ${seen.frames} audio frames fed, ${mp3.length} bytes out`);
  const [l0, r0, fmt, ch] = seen.planes[0];
  console.log(`  AudioData format=${fmt}, channels=${ch}`);
  console.log(`  planar split correct: L[0]=${l0.toFixed(3)} (expect ${L[0].toFixed(3)}), R[0]=${r0.toFixed(3)} (expect ${R[0].toFixed(3)})`);
  const okPlanar = Math.abs(l0 - L[0]) < 1e-6 && Math.abs(r0 - R[0]) < 1e-6;
  const allFrames = seen.frames === len;
  console.log(`  every sample fed: ${allFrames} (${seen.frames}/${len})`);
  const sync = (mp3[0] === 0xFF && (mp3[1] & 0xE0) === 0xE0);
  console.log(`  output starts with an MPEG audio sync word: ${sync}`);
  const expectedChunks = Math.ceil(len / 1152);
  console.log(`  frame chunking: ${seen.chunks} chunks (expected ${expectedChunks} of 1152 frames)`);
  const verdict = okPlanar && allFrames && sync && seen.chunks === expectedChunks;
  console.log(verdict ? "\nMP3 PLUMBING VERIFIED" : "\nMP3 PLUMBING BROKEN");
  if (!verdict) process.exit(1);
})().catch(e => { console.log("FAIL:", e.message); process.exit(1); });
