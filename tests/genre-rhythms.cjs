require("./shim.cjs");
const fs = require("fs");
const m = new module.constructor();
m._compile(fs.readFileSync(require("path").join(__dirname, "..", "build", "app.js"),"utf8") + "\n;module.exports={GENRES,loadPreset,state,TRACK_DEFS};", "/tmp/p.js");
const api = m.exports;
const stepsOf = (k, lane) => {
  api.loadPreset(k);
  return [...api.state.tracks[lane].steps.keys()].sort((a,b) => a-b);
};
const bar = (arr, b) => arr.filter(s => Math.floor(s/16) === b).map(s => s % 16);
let pass = true;
function check(name, cond, detail){
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) pass = false;
}

console.log("signature-rhythm checks\n");

// House: four-on-the-floor kick + clap on 2 and 4 + offbeat open hats
let k = stepsOf("house","kick"), c = stepsOf("house","clap"), o = stepsOf("house","ohat");
check("house kick is four-on-the-floor", bar(k,0).join()==="0,4,8,12" && bar(k,1).join()==="0,4,8,12", "kick @"+bar(k,0).join(","));
check("house clap on beats 2 & 4", bar(c,0).join()==="4,12", "clap @"+bar(c,0).join(","));
check("house open hats on the offbeats", bar(o,0).join()==="2,6,10,14", "ohat @"+bar(o,0).join(","));

// Techno: four-on-floor + rolling 16th bass
k = stepsOf("techno","kick"); const b = stepsOf("techno","bass");
check("techno kick is four-on-the-floor", bar(k,0).join()==="0,4,8,12");
check("techno bass rolls in 16ths", bar(b,0).length === 16, bar(b,0).length + " bass hits per bar");

// Reggaeton: dembow = kick 1 & 3, snare on 3,6,11,14
k = stepsOf("reggaeton","kick"); const sn = stepsOf("reggaeton","snare");
check("reggaeton kick on 1 & 3", bar(k,0).join()==="0,8", "kick @"+bar(k,0).join(","));
check("reggaeton dembow snare", bar(sn,0).join()==="3,6,11,14", "snare @"+bar(sn,0).join(","));

// Jersey club: rapid triplet kicks + backbeat claps
k = stepsOf("jersey","kick");
check("jersey kick has the triplet clusters", bar(k,0).includes(3) && bar(k,0).includes(6) && bar(k,0).includes(11),
      "kick @"+bar(k,0).join(","));

// Dubstep: half-time, kick 1, snare on beat 3
k = stepsOf("dubstep","kick"); const ds = stepsOf("dubstep","snare");
check("dubstep is half-time (2 kicks in 2 bars)", k.length === 2, k.length + " kicks");
check("dubstep snare on beat 3", ds.includes(8) && ds.includes(24), "snare steps " + ds.join(","));

// DnB: 2-step with ghost snares
k = stepsOf("dnb","kick"); const dsn = stepsOf("dnb","snare");
check("dnb kick on 1 and the 'and of 3'", bar(k,0).join()==="0,10", "kick @"+bar(k,0).join(","));
check("dnb has ghost snares", dsn.length > 4, dsn.length + " snare hits (4 backbeats + ghosts)");

// Garage: 2-step kick
k = stepsOf("ukgarage","kick");
check("uk garage kick is 2-step", bar(k,0).join()==="0,10", "kick @"+bar(k,0).join(","));

// Boom bap: swung hats, kick on 1 and the 'and of 3'
k = stepsOf("boombap","kick");
check("boom bap kick lands 1 and 'and of 3'", bar(k,0).join()==="0,10", "kick @"+bar(k,0).join(","));

// Trap / drill: half-time clap on beat 3
c = stepsOf("trap","clap");
check("trap clap on beat 3 only", bar(c,0).join()==="8", "clap @"+bar(c,0).join(","));

// Dancehall: one-drop = kick 1 + the "and of 2", snare on beat 3
k = stepsOf("dancehall","kick"); const dhsn = stepsOf("dancehall","snare");
check("dancehall kick is the one-drop bounce", bar(k,0).join()==="0,6", "kick @"+bar(k,0).join(","));
check("dancehall snare on beat 3", bar(dhsn,0).join()==="8", "snare @"+bar(dhsn,0).join(","));

// Afrobeats + amapiano: 4 bars, shaker running in 16ths
const hatAfro = stepsOf("afrobeats","hat");
check("afrobeats runs 4 bars of 16th shaker", hatAfro.length === 64, hatAfro.length + " shaker hits over 4 bars");
const hatAmp = stepsOf("amapiano","hat");
check("amapiano runs 16th shaker", hatAmp.length === 64, hatAmp.length + " shaker hits over 4 bars");
const ampBass = stepsOf("amapiano","bass");
api.loadPreset("amapiano");
const pitches = [...api.state.tracks.bass.steps.values()].map(n => n.pitch);
check("amapiano log drum moves through the scale", new Set(pitches).size >= 4,
      "distinct bass pitches: " + [...new Set(pitches)].sort().join(","));

// Pop: four-on-floor
k = stepsOf("pop","kick");
check("pop kick is four-on-the-floor", bar(k,0).join()==="0,4,8,12");

// Lofi / funk: swung 8th hats present
const lh = stepsOf("lofi","hat");
check("lo-fi hats on every 8th", lh.filter(s => s%2===0).length === 16, lh.length + " hat hits in 2 bars");

console.log("\n" + (pass ? "ALL SIGNATURE RHYTHMS CORRECT" : "SOME CHECKS FAILED"));
if (!pass) process.exit(1);
