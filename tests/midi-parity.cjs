#!/usr/bin/env node
/* MIDI contract test shared by the browser sequencer and browser transcriber. */
require("./shim.cjs");
const fs = require("fs");
const path = require("path");
const code = fs.readFileSync(path.join(__dirname, "..", "build", "app.js"), "utf8") +
  "\n;module.exports={buildSMF};";
const m = new module.constructor(); m._compile(code, "/tmp/midi-parity.js");
const { buildSMF } = m.exports;
let failures = 0;
function check(label, ok, detail = "") { console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failures++; }
function vlq(b, p) { let v = 0; do { v = (v << 7) | (b[p.i] & 0x7f); } while (b[p.i++] & 0x80); return v; }
function tracksOf(bytes) {
  const n = (bytes[10] << 8) | bytes[11], out = []; let p = 14;
  for (let t = 0; t < n; t++) {
    if (String.fromCharCode(...bytes.slice(p, p + 4)) !== "MTrk") throw Error("bad MTrk");
    const len = bytes[p + 4] * 2 ** 24 + bytes[p + 5] * 2 ** 16 + bytes[p + 6] * 256 + bytes[p + 7];
    const end = p + 8 + len, body = bytes.slice(p + 8, end), ev = []; let i = { i:0 }, running = null, tick = 0;
    while (i.i < body.length) {
      tick += vlq(body, i); let st = body[i.i++];
      if (st < 0x80) { i.i--; st = running; } else if (st < 0xf0) running = st;
      if (st === 0xff) { const typ = body[i.i++], ln = vlq(body, i), data = body.slice(i.i, i.i + ln); i.i += ln; ev.push({kind:"meta", typ, tick, data}); }
      else { const hi = st & 0xf0, ch = st & 0x0f, npar = hi === 0xc0 || hi === 0xd0 ? 1 : 2, a = body[i.i++], d = npar === 2 ? body[i.i++] : null; ev.push({kind:"chan", hi, ch, a, d, tick}); }
    }
    out.push(ev); p = end;
  }
  return out;
}
console.log("MIDI parity contract checks");
const bytes = buildSMF([{name:"Kick", channel:9, notes:[{step:0,pitch:36,len:1,vel:1},{step:4,pitch:36,len:1,vel:.8}]}, {name:"Bass", channel:2, notes:[{step:0,pitch:45,len:2,vel:.7}]}], 140, 480, 16);
const ts = tracksOf(bytes), conductor = ts[0];
check("SMF is type 1 at 480 PPQ", bytes[8] === 0 && bytes[9] === 1 && bytes[12] === 1 && bytes[13] === 0xe0, `${bytes[12] * 256 + bytes[13]} ppq`);
const name = conductor.find(e => e.kind === "meta" && e.typ === 3);
check("conductor track is named BEATFORGE", name && Buffer.from(name.data).toString() === "BEATFORGE");
const copyright = conductor.find(e => e.kind === "meta" && e.typ === 2);
check("conductor carries Mike 1ne / 7H attribution", copyright && /Mike 1ne/.test(Buffer.from(copyright.data).toString()) && /7H Music Group/.test(Buffer.from(copyright.data).toString()));
const sig = conductor.find(e => e.kind === "meta" && e.typ === 0x58);
check("conductor has the 4/4 time signature", sig && sig.data.join(",") === "4,2,24,8");
for (const [idx, ev] of ts.slice(1).entries()) {
  const ons = ev.filter(e => e.kind === "chan" && e.hi === 0x90 && e.d > 0), offs = ev.filter(e => e.kind === "chan" && e.hi === 0x80);
  check(`track ${idx + 1} note-offs use 0x8n velocity 0x40`, offs.length === ons.length && offs.every(e => e.d === 0x40));
  check(`track ${idx + 1} ends with end-of-track`, ev.some(e => e.kind === "meta" && e.typ === 0x2f));
  if (idx === 0) check("drum notes are on channel 10", ons.every(e => e.ch === 9) && ons.every(e => [36,38,39,42,46].includes(e.a)));
}
console.log(failures ? `\n${failures} MIDI CHECK(S) FAILED` : "\nMIDI CONTRACT VERIFIED");
if (failures) process.exit(1);
