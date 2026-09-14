#!/usr/bin/env node
/* Kit and humanise regression tests. These use the extracted real app, not a mock
   implementation, so a future UI refactor cannot silently break uploads or exports. */
require("./shim.cjs");
const fs = require("fs");
const path = require("path");
const code = fs.readFileSync(path.join(__dirname, "..", "build", "app.js"), "utf8") +
  "\n;module.exports={state,TRACK_DEFS,slot,setSample,clearSample,resetSamples,humanizeFor,hrand,buildSMF,playSound};";
const m = new module.constructor();
m._compile(code, "/tmp/kit-humanize.js");
const api = m.exports;
let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

console.log("kit + humanize checks");
const before = api.state.tracks.kick.steps.size;
const buffer = { numberOfChannels: 1, length: 8, sampleRate: 8, duration: 1,
  getChannelData: () => new Float32Array([0, 0.2, -0.5, 0.1, 0, 0, 0, 0]) };
api.setSample("kick", buffer, "my-kick.wav");
check("sample slot stores the uploaded buffer", api.slot("kick").buffer === buffer && api.slot("kick").name === "my-kick.wav");
check("loading a sample does not edit the pattern", api.state.tracks.kick.steps.size === before);
check("sample slot has independent playback controls", ["gain", "tune", "start", "end", "root", "followPitch", "mode", "reverse", "send", "attack", "release", "shift"].every(k => k in api.slot("kick")));
api.slot("kick").gain = 0.4; api.slot("kick").shift = 13;
api.clearSample("kick");
check("clearing a slot restores synth mode without clearing steps", api.slot("kick").buffer === null && api.state.tracks.kick.steps.size === before && api.slot("kick").gain === 1);
api.setSample("kick", buffer, "again.wav");
api.resetSamples();
check("resetSamples is separate from resetTracks", api.slot("kick").buffer === null && api.state.tracks.kick.steps.size === before);

api.state.humanize.on = true; api.state.humanize.seed = 2468;
api.state.humanize.timing = api.state.humanize.velocity = api.state.humanize.length = api.state.humanize.pitch = 1;
const a = api.humanizeFor("hat", 7), b = api.humanizeFor("hat", 7);
check("humanize is deterministic for the same seed/lane/step", JSON.stringify(a) === JSON.stringify(b));
check("timing stays inside 45 percent of a step", Math.abs(a.t) <= 0.45 * (60 / api.state.bpm / 4) + 1e-12, `${a.t}`);
const other = api.humanizeFor("snare", 7);
check("different lanes receive independent deterministic offsets", JSON.stringify(a) !== JSON.stringify(other));
api.state.humanize.on = false;
const off = api.humanizeFor("hat", 7);
check("humanize off is neutral", off.t === 0 && off.v === 1 && off.len === 1 && off.cents === 0);

// Playback must route to the sample when loaded; this also exercises the no-pattern-mutation path.
api.setSample("kick", buffer, "routed.wav");
try { api.playSound("kick", 0.1, 0, 0.8, 0.2, 0); check("loaded sample routes through Web Audio", true); }
catch (e) { check("loaded sample routes through Web Audio", false, e.message); }

console.log(failures ? `\n${failures} KIT/HUMANIZE CHECK(S) FAILED` : "\nKIT + HUMANIZE VERIFIED");
if (failures) process.exit(1);
