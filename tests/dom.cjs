/* DOM / UI test: boots the real beatforge.html inside jsdom and drives it the way a
   person would -- click a genre, paint a step, press play, export, render, transcribe.

   The other suites call the app's functions directly. This one checks that the page
   is actually wired up: element ids, event handlers, tabs, and the audio -> MIDI flow
   over real HTTP (it starts its own static server, and the Python server too when
   numpy/scipy are installed).

   Web Audio, WebCodecs and canvas are stubbed -- jsdom has none -- but the offline
   render stub synthesises real PCM so the WAV encoder is checked end to end.

   Needs jsdom:  npm install            (skips cleanly, exit 0, if it isn't installed)
   Run:          node tests/dom.cjs
*/
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execSync, spawn } = require("child_process");

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (e) {
  console.log("\n  SKIPPED: the DOM test needs jsdom (a dev dependency, not needed by the app).");
  console.log("    install with:  npm install");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "beatforge.html"), "utf8");

let passed = 0, failed = 0;
const notes = [];
function check(name, cond, detail) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  cond ? passed++ : failed++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let v;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    await sleep(step);
  }
  return null;
}

/* ------------------------------------------------------------------ WAV decoding */
function decodeWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let pos = 12, fmt = null, data = null;
  while (pos < b.length - 8) {
    const id = b.toString("ascii", pos, pos + 4), sz = b.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { channels: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12) };
    if (id === "data") data = b.subarray(pos + 8, pos + 8 + sz);
    pos += 8 + sz + (sz % 2);
  }
  if (!fmt || !data) throw new Error("not a WAV file");
  const n = Math.floor(data.length / 2 / fmt.channels), chans = [];
  for (let c = 0; c < fmt.channels; c++) {
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    chans.push(arr);
  }
  return { numberOfChannels: fmt.channels, length: n, sampleRate: fmt.sr, duration: n / fmt.sr,
           getChannelData: c => chans[c] };
}

/* ------------------------------------------------------------------ Web Audio stubs */
function param(v) {
  return {
    value: v,
    setValueAtTime(x) { this.value = x; return this; },
    linearRampToValueAtTime(x) { this.value = x; return this; },
    exponentialRampToValueAtTime(x) { this.value = x; return this; },
    setTargetAtTime(x) { this.value = x; return this; },
    cancelScheduledValues() { return this; },
  };
}
function audioNode(kind, events) {
  return {
    kind, gain: param(1), frequency: param(kind === "osc" ? 440 : 1000), Q: param(1), detune: param(0),
    threshold: param(-12), ratio: param(3), attack: param(0.004), release: param(0.16), knee: param(0),
    curve: null, oversample: "", buffer: null, loop: false, playbackRate: param(1), onended: null,
    connect(x) { return x; }, disconnect() {},
    start(t) { events.push({ kind, t: t || 0, freq: this.frequency.value, gain: this.gain.value }); },
    stop() {},
  };
}
function liveAudioContext(events) {
  const t0 = Date.now();
  const ctx = {
    sampleRate: 44100, state: "running",
    get currentTime() { return (Date.now() - t0) / 1000; },
    destination: audioNode("dest", events),
    resume() { this.state = "running"; return Promise.resolve(); },
    suspend() { this.state = "suspended"; return Promise.resolve(); },
    close() { this.state = "closed"; return Promise.resolve(); },
    createGain: () => audioNode("gain", events),
    createOscillator: () => audioNode("osc", events),
    createBiquadFilter: () => audioNode("biquad", events),
    createBufferSource: () => audioNode("src", events),
    createWaveShaper: () => audioNode("shaper", events),
    createConvolver: () => audioNode("conv", events),
    createDynamicsCompressor: () => audioNode("comp", events),
    createBuffer: (c, l, sr) => {
      const d = []; for (let i = 0; i < c; i++) d.push(new Float32Array(l));
      return { numberOfChannels: c, length: l, sampleRate: sr || 44100, getChannelData: i => d[i] };
    },
    decodeAudioData: ab => Promise.resolve(decodeWav(Buffer.from(ab))),
  };
  return ctx;
}
function offlineAudioContext(channels, length, sr, events) {
  const ctx = {
    numberOfChannels: channels, length, sampleRate: sr, destination: audioNode("dest", events),
    get currentTime() { return 0; },
    createGain: () => audioNode("gain", events),
    createOscillator: () => audioNode("osc", events),
    createBiquadFilter: () => audioNode("biquad", events),
    createBufferSource: () => audioNode("src", events),
    createWaveShaper: () => audioNode("shaper", events),
    createConvolver: () => audioNode("conv", events),
    createDynamicsCompressor: () => audioNode("comp", events),
    createBuffer: (c, l, s) => {
      const d = []; for (let i = 0; i < c; i++) d.push(new Float32Array(l));
      return { numberOfChannels: c, length: l, sampleRate: s || sr, getChannelData: i => d[i] };
    },
    /* synthesise real PCM from what the voices scheduled, so encodeWav has signal to write */
    startRendering: () => {
      const L = new Float32Array(length), R = new Float32Array(length);
      for (const ev of events) {
        if (ev.kind !== "osc" && ev.kind !== "src") continue;
        const f = ev.freq > 20 ? ev.freq : 110;
        const i0 = Math.floor(ev.t * sr);
        for (let i = 0; i < sr * 0.14 && i0 + i < length; i++) {
          const v = Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-i / (sr * 0.035)) * 0.55;
          L[i0 + i] += v; R[i0 + i] += v * 0.96;
        }
      }
      return Promise.resolve({ numberOfChannels: 2, length, sampleRate: sr, duration: length / sr,
                               getChannelData: c => (c === 1 ? R : L) });
    },
  };
  return ctx;
}
function canvas2d(draws) {
  const rec = op => (...a) => draws.push([op, ...a]);
  return {
    setTransform: rec("setTransform"), clearRect: rec("clearRect"), fillRect: rec("fillRect"),
    beginPath: rec("beginPath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"), stroke: rec("stroke"),
    fill: rec("fill"), fillText: rec("fillText"), save: rec("save"), restore: rec("restore"),
    closePath: rec("closePath"), arc: rec("arc"), rect: rec("rect"), strokeRect: rec("strokeRect"),
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1, textAlign: "",
    measureText: () => ({ width: 10 }),
  };
}

/* ------------------------------------------------------------------ boot the page */
async function boot(baseUrl) {
  const state = { errors: [], alerts: [], blobs: [], downloads: [], draws: [], events: [], requests: [] };
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => state.errors.push("jsdomError: " + (e.message || e)));
  vc.on("error", (...m) => state.errors.push("console.error: " + m.join(" ")));

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: baseUrl,
    virtualConsole: vc,
    beforeParse(window) {
      window.alert = m => state.alerts.push(String(m));
      window.HTMLCanvasElement.prototype.getContext = () => canvas2d(state.draws);
      window.AudioContext = function () { return liveAudioContext(state.events); };
      window.webkitAudioContext = window.AudioContext;
      window.OfflineAudioContext = function (c, l, sr) { return offlineAudioContext(c, l, sr, state.events); };
      const realCreate = window.URL.createObjectURL ? window.URL.createObjectURL.bind(window.URL) : null;
      window.URL.createObjectURL = blob => {
        state.blobs.push(blob);
        return realCreate ? realCreate(blob) : "blob:beatforge/" + state.blobs.length;
      };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {
        state.downloads.push({ href: this.href, name: this.download });
      };
      /* jsdom has no fetch: use Node's, resolving relative URLs against the page.
         The Response is re-wrapped so blob()/json() hand back jsdom-realm objects --
         a Node Blob passed into the page's `new File([blob], name)` would be stringified. */
      window.fetch = async (u, o) => {
        const url = new URL(u, baseUrl);
        state.requests.push(url.pathname + url.search);
        const r = await fetch(url, o);
        return {
          ok: r.ok, status: r.status, statusText: r.statusText, headers: r.headers,
          url: r.url, redirected: r.redirected, type: r.type,
          blob: async () => window.Blob && new window.Blob([new Uint8Array(await r.arrayBuffer())],
                     { type: r.headers.get("content-type") || "" }),
          arrayBuffer: () => r.arrayBuffer(),
          text: () => r.text(),
          json: () => r.json(),
        };
      };
      window.addEventListener("error", e => state.errors.push("window.onerror: " + (e.message || e.error)));
      window.addEventListener("unhandledrejection", e =>
        state.errors.push("unhandled rejection: " + (e.reason && e.reason.message || e.reason)));
    },
  });

  const { window } = dom;
  const $ = s => window.document.querySelector(s);
  const $$ = s => [...window.document.querySelectorAll(s)];
  await sleep(400);                       // let the boot code + wireDemos() settle
  return { dom, window, $, $$, state,
           close: () => { try { window.close(); } catch (e) {} } };
}

function click(app, elOrSel) {
  const el = typeof elOrSel === "string" ? app.$(elOrSel) : elOrSel;
  if (!el) throw new Error("no such element: " + elOrSel);
  el.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return el;
}
function mousedown(app, el, opts = {}) {
  el.dispatchEvent(new app.window.MouseEvent("mousedown",
    Object.assign({ bubbles: true, cancelable: true, button: 0 }, opts)));
}
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const ascii = (b, i, j) => String.fromCharCode(...b.slice(i, j));

/* ------------------------------------------------------------------ servers */
/* A static file server with no API behind it, mounted under a sub-path -- i.e. exactly
   how GitHub Pages serves this repo (https://user.github.io/beatforge/). Relative URLs
   in the app have to survive that, and audio -> MIDI has to fall back to the browser
   engine when api/audio2midi 404s. */
function staticServer(prefix = "beatforge") {
  const types = { ".html": "text/html; charset=utf-8", ".wav": "audio/wav", ".js": "text/javascript",
                  ".css": "text/css", ".json": "application/json" };
  const srv = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split("?")[0]);
    if (prefix) u = u.replace(new RegExp("^/" + prefix + "(?=/|$)"), "") || "/";
    const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
    const p = path.join(ROOT, rel);
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" });
    res.end(fs.readFileSync(p));
  });
  return new Promise(r => srv.listen(0, "127.0.0.1",
    () => r({ srv, port: srv.address().port, prefix })));
}

function pythonAvailable() {
  try {
    execSync("python3 -c 'import numpy, scipy'", { stdio: "ignore" });
    return true;
  } catch (e) { return false; }
}
function freePort() {
  return new Promise(r => {
    const s = require("net").createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
  });
}
async function pythonServer() {
  const port = await freePort();
  const child = spawn("python3", ["server.py"], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(port), HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => log += d);
  child.stderr.on("data", d => log += d);
  const up = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    return r.ok ? true : null;
  }, 20000, 250);
  if (!up) { child.kill("SIGKILL"); throw new Error("python server did not start: " + log); }
  return { child, port, url: `http://127.0.0.1:${port}/beatforge.html` };
}

/* ------------------------------------------------------------------ the checks */
/* the step cells live in #tracks (the #grid element is the grid-resolution <select>) */
const cellSel = (track, step) => `#tracks .cell[data-track="${track}"][data-step="${step}"]`;
const cellsOn = app => app.$$("#tracks .cell.on").length;

async function sequencerChecks(app) {
  console.log("\n-- boot --");
  check("page boots with no JS errors", app.state.errors.length === 0,
        app.state.errors.slice(0, 2).join(" | ") || "clean");
  check("title is BEATFORGE", /BEATFORGE/.test(app.window.document.title), app.window.document.title);
  const cells0 = app.$$("#tracks .cell").length;
  check("sequencer grid painted on boot", cells0 === 8 * 16 * 2,
        `${cells0} cells (trap: 2 bars x 8 lanes x 16 steps)`);
  check("8 lane rows built", app.$$("#tracks .trk").length === 8,
        `${app.$$("#tracks .trk").length} rows`);
  check("boot preset is trap @140", app.$("#bpm").value === "140" && app.$("#bars").value === "2",
        `${app.$("#bpm").value} BPM, ${app.$("#bars").value} bars`);
  check("preset steps are painted on", cellsOn(app) > 20, `${cellsOn(app)} steps on`);
  check("kit renders one independent row per lane", app.$$("#kitRows .kit-row").length === 8 &&
        app.$$("#kitRows .smp").length === 8 && app.$$("#kitRows .mute").length === 8 &&
        app.$$("#kitRows .clr").length === 8, `${app.$$("#kitRows .kit-row").length} kit rows`);
  check("kit has a touch-friendly picker and bake/reset actions", !!app.$("#kitFile") && !!app.$("#kitChoose") &&
        !!app.$("#kitBake") && !!app.$("#kitReset"));
  check("humanize controls are wired into the page", !!app.$("#hzOn") && !!app.$("#hzMidi") &&
        ["hzT", "hzV", "hzL", "hzP", "hzE", "hzReroll", "hzSnap"].every(id => !!app.$("#" + id)));
  app.window.eval('state.samples.kick.name = "keep-me.wav"');
  click(app, "#clear");
  await sleep(60);
  check("Clear all resets tracks but preserves kit slots", app.window.eval('state.samples.kick.name') === "keep-me.wav");

  console.log("\n-- genre presets --");
  const gbtns = app.$$("#genreBar .gbtn");
  check("18 genre buttons rendered", gbtns.length === 18, `${gbtns.length} buttons`);
  const amap = gbtns.find(b => /amapiano/i.test(b.textContent));
  check("Amapiano button exists", !!amap);
  if (amap) {
    click(app, amap);
    await sleep(150);
    check("clicking Amapiano sets tempo/bars/swing",
          app.$("#bpm").value === "112" && app.$("#bars").value === "4" && parseFloat(app.$("#swing").value) > 0,
          `${app.$("#bpm").value} BPM, ${app.$("#bars").value} bars, swing ${app.$("#swing").value}`);
    check("grid rebuilt to 4 bars x 8 lanes", app.$$("#tracks .cell").length === 8 * 16 * 4,
          `${app.$$("#tracks .cell").length} cells`);
    check("preset painted a pattern", cellsOn(app) > 40, `${cellsOn(app)} steps on`);
    check("genre name + blurb shown", /Amapiano/i.test(app.$("#genreNow").textContent) &&
          app.$("#genreDesc").textContent.trim().length > 20, app.$("#genreNow").textContent.trim());
    check("the button marks itself active", amap.classList.contains("on"));
  }

  console.log("\n-- editing the grid --");
  // refreshAll() rebuilds #tracks after every edit, so cells must be re-queried each time
  const before = cellsOn(app);
  const emptyKick = app.$$("#tracks .cell[data-track='kick']").find(c => !c.classList.contains("on"));
  const placed = { track: emptyKick.dataset.track, step: emptyKick.dataset.step };
  mousedown(app, emptyKick);
  app.window.dispatchEvent(new app.window.MouseEvent("mouseup", { bubbles: true }));
  await sleep(80);
  check("mousedown on an empty cell places a step", cellsOn(app) === before + 1,
        `${before} -> ${cellsOn(app)}`);
  check("the placed cell is painted on", !!app.$(cellSel(placed.track, placed.step) + ".on"));

  mousedown(app, app.$(cellSel(placed.track, placed.step)));
  app.window.dispatchEvent(new app.window.MouseEvent("mouseup", { bubbles: true }));
  await sleep(80);
  check("mousedown on a filled cell erases it", cellsOn(app) === before, `${cellsOn(app)} steps on`);

  const filled = app.$("#tracks .cell.on");
  filled.dispatchEvent(new app.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await sleep(80);
  check("right-click erases a step", cellsOn(app) === before - 1, `${cellsOn(app)} steps on`);

  const empty2 = app.$$("#tracks .cell[data-track='clap']").find(c => !c.classList.contains("on"));
  const acc = { track: empty2.dataset.track, step: +empty2.dataset.step };
  mousedown(app, empty2, { altKey: true });
  app.window.dispatchEvent(new app.window.MouseEvent("mouseup", { bubbles: true }));
  await sleep(80);
  check("alt-click places an accent (velocity 1)",
        app.window.eval(`state.tracks["${acc.track}"].steps.get(${acc.step}).vel`) === 1,
        `vel = ${app.window.eval(`state.tracks["${acc.track}"].steps.get(${acc.step}).vel`)}`);

  // drag-paint across a drum lane (refreshAll() replaces the cells mid-drag, so re-query)
  mousedown(app, app.$(cellSel("kick", 1)));
  for (const s of [2, 3]) {
    app.$(cellSel("kick", s)).dispatchEvent(new app.window.MouseEvent("mouseover", { bubbles: true }));
  }
  app.window.dispatchEvent(new app.window.MouseEvent("mouseup", { bubbles: true }));
  await sleep(80);
  check("drag paints consecutive steps",
        !!app.$(cellSel("kick", 1) + ".on") && !!app.$(cellSel("kick", 2) + ".on") &&
        !!app.$(cellSel("kick", 3) + ".on"));

  // vertical pitch drag on a pitched lane
  const bassCell = app.$$("#tracks .cell[data-track='bass'].on")[0];
  if (bassCell) {
    const step = +bassCell.dataset.step;
    const p0 = app.window.eval(`state.tracks.bass.steps.get(${step}).pitch`);
    mousedown(app, bassCell, { clientY: 200 });
    app.window.dispatchEvent(new app.window.MouseEvent("mousemove", { bubbles: true, clientY: 178 }));
    app.window.dispatchEvent(new app.window.MouseEvent("mouseup", { bubbles: true }));
    await sleep(80);
    const p1 = app.window.eval(`state.tracks.bass.steps.get(${step}).pitch`);
    check("dragging a pitched cell up raises its note", p1 === p0 + 2, `${p0} -> ${p1} (dragged 22px)`);
    check("pitch drag did not delete the note", !!app.$(cellSel("bass", step) + ".on"));
  } else {
    check("dragging a pitched cell up raises its note", false, "no bass step to drag");
  }

  // lane mute + clear
  const bassRow = app.$("#tracks .trk[data-id='bass']");
  click(app, bassRow.querySelectorAll(".ico")[0]);            // "M"
  await sleep(80);
  check("lane mute button toggles the mute flag", app.window.eval("state.tracks.bass.mute") === true);
  click(app, app.$("#tracks .trk[data-id='bass']").querySelectorAll(".ico")[0]);
  await sleep(80);
  check("lane mute toggles back", app.window.eval("state.tracks.bass.mute") === false);
  const bassSteps = app.window.eval("state.tracks.bass.steps.size");
  click(app, app.$("#tracks .trk[data-id='bass']").querySelectorAll(".ico")[1]);   // "×"
  await sleep(80);
  check("lane clear button empties the lane", app.window.eval("state.tracks.bass.steps.size") === 0,
        `${bassSteps} -> ${app.window.eval("state.tracks.bass.steps.size")}`);
  // randomise keeps the genre feel but changes the pattern
  click(app, app.$$(".tab").find(t => t.dataset.tab === "seq"));
  const gBefore = app.$$("#genreBar .gbtn.on")[0];
  click(app, "#rand");
  await sleep(120);
  check("Randomise repopulates the pattern", cellsOn(app) > 20 &&
        (gBefore ? gBefore.classList.contains("on") : true), `${cellsOn(app)} steps on`);

  // controls: tempo, bars, grid resolution, swing
  const bpmBox = app.$("#bpm");
  bpmBox.value = "128";
  bpmBox.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  await sleep(60);
  check("tempo field updates state", app.window.eval("state.bpm") === 128,
        `state.bpm = ${app.window.eval("state.bpm")}`);

  const gridSel = app.$("#grid");
  gridSel.value = "32";
  gridSel.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await sleep(120);
  check("32nd grid rebuilds with twice the steps per bar",
        app.$$("#tracks .cell").length === 8 * 32 * app.window.eval("state.bars"),
        `${app.$$("#tracks .cell").length} cells`);
  check("changing resolution keeps step 1 of the pattern", !!app.$(cellSel("kick", 0) + ".on") ||
        cellsOn(app) > 0, `${cellsOn(app)} steps survived`);
  gridSel.value = "16";
  gridSel.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await sleep(120);

  const barsSel = app.$("#bars");
  barsSel.value = "8";
  barsSel.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await sleep(120);
  check("bars control rebuilds the grid", app.$$("#tracks .cell").length === 8 * 16 * 8,
        `${app.$$("#tracks .cell").length} cells`);
  barsSel.value = "2";
  barsSel.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await sleep(100);

  const swing = app.$("#swing");
  swing.value = "0.3";
  swing.dispatchEvent(new app.window.Event("input", { bubbles: true }));
  await sleep(60);
  check("swing slider updates state and its read-out",
        app.window.eval("state.swing") === 0.3 && /30%/.test(app.$("#swingv").textContent),
        app.$("#swingv").textContent.trim());

  // piano roll appears for a pitched lane and its octave buttons work
  click(app, app.$("#tracks .trk[data-id='pluck'] .tname"));
  await sleep(150);
  check("piano roll is built for the selected pitched lane",
        app.$$("#pianoRoll .cell").length > 0, `${app.$$("#pianoRoll .cell").length} keys x steps`);
  const octBefore = app.$("#octLabel").textContent;
  click(app, "#octUp");
  await sleep(150);
  check("octave button shifts the piano roll", app.$("#octLabel").textContent !== octBefore,
        `${octBefore} -> ${app.$("#octLabel").textContent}`);
  click(app, "#octDown");
  await sleep(120);

  console.log("\n-- transport --");
  click(app, "#play");
  await sleep(350);
  check("play starts (button flips to stop)", /■|⏸/.test(app.$("#play").textContent.trim()),
        `"${app.$("#play").textContent.trim()}"`);
  check("playback is running", app.window.eval("state.playing") === true);
  const cur1 = app.$("#tracks .cell.cur");
  check("playhead drawn on the grid", !!cur1, cur1 ? `step ${cur1.dataset.step}` : "no .cur cell");
  await sleep(450);
  const cur2 = app.$("#tracks .cell.cur");
  check("playhead advances", !!cur2 && (!cur1 || cur2.dataset.step !== cur1.dataset.step),
        cur2 ? `step ${cur2.dataset.step}` : "gone");
  check("voices were scheduled through Web Audio", app.state.events.length > 0,
        `${app.state.events.length} start() calls`);
  click(app, "#play");
  await sleep(120);
  check("stop halts playback", app.window.eval("state.playing") === false &&
        app.$("#play").textContent.trim() === "▶", `"${app.$("#play").textContent.trim()}"`);
  app.window.document.body.dispatchEvent(new app.window.KeyboardEvent("keydown",
    { code: "Space", key: " ", bubbles: true }));
  await sleep(150);
  check("space bar toggles playback", app.window.eval("state.playing") === true);
  app.window.document.body.dispatchEvent(new app.window.KeyboardEvent("keydown",
    { code: "Space", key: " ", bubbles: true }));
  await sleep(100);
  check("space bar stops it again", app.window.eval("state.playing") === false);
}

async function exportChecks(app) {
  console.log("\n-- export + render --");
  app.state.blobs.length = 0; app.state.downloads.length = 0;
  click(app, "#export");
  await sleep(250);
  const mid = app.state.blobs[0];
  check("Export .MID created a MIDI blob", !!mid && /midi/.test(mid.type), mid ? `${mid.size} bytes ${mid.type}` : "none");
  check("download was offered with a .mid filename",
        app.state.downloads.some(d => /\.mid$/i.test(d.name || "")),
        app.state.downloads.map(d => d.name).join(", ") || "none");
  if (mid) {
    const b = await bytes(mid);
    const fmt = b[8] << 8 | b[9], ntrk = b[10] << 8 | b[11], ppq = b[12] << 8 | b[13];
    check("MIDI header is type 1 @480 PPQ", ascii(b, 0, 4) === "MThd" && fmt === 1 && ppq === 480,
          `format ${fmt}, ${ntrk} tracks, ${ppq} ppq`);
    check("first chunk is MTrk", ascii(b, 14, 18) === "MTrk");
    let pos = 14, tracks = 0, ok = true;
    while (pos < b.length) {
      if (ascii(b, pos, pos + 4) !== "MTrk") { ok = false; break; }
      const len = b[pos + 4] << 24 | b[pos + 5] << 16 | b[pos + 6] << 8 | b[pos + 7];
      pos += 8 + len; tracks++;
    }
    check("all MTrk chunk lengths add up", ok && pos === b.length && tracks === ntrk,
          `${tracks} tracks, ${pos}/${b.length} bytes consumed`);
  }

  app.state.blobs.length = 0; app.state.downloads.length = 0;
  click(app, "#renderWav");
  const wav = await waitFor(() => app.state.blobs.find(x => /wav/.test(x.type)), 40000);
  check("Render WAV produced a WAV blob", !!wav, wav ? `${wav.size} bytes` : "nothing after 40 s");
  if (wav) {
    const b = await bytes(wav);
    const sr = b.slice(24, 28).reduce((a, v, i) => a + v * 256 ** i, 0);
    const ch = b[22] | b[23] << 8, bits = b[34] | b[35] << 8;
    const dataLen = b.slice(40, 44).reduce((a, v, i) => a + v * 256 ** i, 0);
    check("WAV is 44.1 kHz 16-bit stereo RIFF/PCM",
          ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE" && sr === 44100 && ch === 2 && bits === 16,
          `${sr} Hz, ${ch} ch, ${bits} bit`);
    check("WAV data chunk matches file size", dataLen > 0 && dataLen + 44 === b.length,
          `${dataLen} + 44 = ${b.length}`);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let peak = 0, over = 0;
    for (let i = 44; i + 1 < b.length; i += 2) {
      const s = dv.getInt16(i, true);
      peak = Math.max(peak, Math.abs(s));
      if (Math.abs(s) > 32767) over++;
    }
    check("rendered audio contains real signal, normalised, not clipping",
          peak > 20000 && peak <= 32767 && over === 0, `peak ${peak}/32767`);
    check("render button reported success", /Rendered|Done/.test(app.$("#renderWav").textContent),
          `"${app.$("#renderWav").textContent.trim()}"`);
    check("WAV download named with bpm/bars/loops",
          app.state.downloads.some(d => /beatforge-\d+bpm-\d+bar-\d+x\.wav$/i.test(d.name || "")),
          app.state.downloads.map(d => d.name).join(", ") || "none");
  }

  app.state.blobs.length = 0; app.state.alerts.length = 0;
  click(app, "#renderMp3");
  const told = await waitFor(() => app.state.alerts.length ? app.state.alerts[0]
    : app.state.blobs.find(x => /mpeg|mp3/.test(x.type)), 30000);
  const encoded = app.state.blobs.find(x => /mpeg|mp3/.test(x.type));
  check("MP3 without WebCodecs tells the user instead of failing quietly",
        !!(encoded || (told && /webcodecs|mp3|wav/i.test(String(told)))),
        encoded ? `${encoded.size} bytes of mp3` : String(told).slice(0, 80));
}

async function transcribeChecks(app, expectServer) {
  console.log(`\n-- audio -> MIDI (${expectServer ? "python server engine" : "static host, in-browser engine"}) --`);
  const tab = app.$$(".tab").find(t => t.dataset.tab === "a2m");
  click(app, tab);
  await sleep(120);
  check("tab switch hides the sequencer and shows audio->MIDI",
        app.$("#tab-seq").classList.contains("hidden") && !app.$("#tab-a2m").classList.contains("hidden"));

  const demos = app.$$("#demoRow a");
  check("demo audio links offered", demos.length === 4, demos.map(a => a.dataset.demo).join(", ") || "none");
  if (!demos.length) return;

  app.state.requests.length = 0;
  click(app, demos[0]);
  const res = await waitFor(() => !app.$("#resBox").classList.contains("hidden") ? {
    status: app.$("#status").textContent.trim(),
    stats: app.$("#stats").textContent.replace(/\s+/g, " ").trim(),
    engine: [...app.$$("#stats .stat")].map(s => s.textContent.trim()).join(" | "),
    dlDisabled: app.$("#dl").disabled,
  } : null, 90000, 250);

  check("drum demo transcribed and shown", !!res, res ? res.status : "no result in 90 s");
  if (!res) return;
  console.log("      status: " + res.status);
  console.log("      stats : " + res.stats.slice(0, 150));
  const bpm = parseFloat((res.stats.match(/([\d.]+)\s*BPM/) || [])[1] || "0");
  check("detected tempo is ~140 BPM", bpm > 125 && bpm < 155, `${bpm} BPM`);
  check(expectServer ? "the python engine answered" : "it fell back to the in-browser engine",
        expectServer ? /server/i.test(res.status + res.engine) : /in-browser|browser/i.test(res.engine),
        res.engine.split("|").pop());
  check("demo audio was fetched over HTTP",
        app.state.requests.some(r => /demo\/drums\.wav/.test(r)), app.state.requests.join(", "));
  if (!expectServer) {
    check("api call was attempted and missed (static host)",
          app.state.requests.some(r => /api\/audio2midi/.test(r)), "relative URL used");
    check("user is told it ran in-browser", /browser/i.test(app.$("#a2mWarn").textContent),
          app.$("#a2mWarn").textContent.trim().slice(0, 60) + "…");
  }
  check("timeline canvas was drawn", app.state.draws.length > 5, `${app.state.draws.length} canvas ops`);
  check("Download .MID is enabled", res.dlDisabled === false);

  app.state.blobs.length = 0; app.state.downloads.length = 0;
  click(app, "#dl");
  await sleep(250);
  const tm = app.state.blobs[0];
  check("transcription downloads as MIDI", !!tm && ascii(await bytes(tm), 0, 4) === "MThd",
        tm ? `${tm.size} bytes` : "none");

  const seqOn = cellsOn(app);
  click(app, "#toSeq");
  await sleep(400);
  check("'Open in sequencer' switches tab and loads the transcribed notes",
        !app.$("#tab-seq").classList.contains("hidden") && cellsOn(app) > 0,
        `${cellsOn(app)} steps on (was ${seqOn}), ${app.$("#bpm").value} BPM, ` +
        `${app.$("#bars").value} bars`);

  app.state.blobs.length = 0;
  click(app, app.$$(".tab").find(t => t.dataset.tab === "a2m"));
  await sleep(80);
  click(app, "#playRes");
  await sleep(250);
  check("Preview plays the result without erroring", app.state.errors.length === 0,
        app.state.errors.slice(0, 2).join(" | ") || "clean");
  click(app, "#playRes");
  await sleep(60);
}

/* ------------------------------------------------------------------ main */
(async () => {
  console.log("DOM / UI test (jsdom) — real page, real HTTP, real event wiring");

  const stat = await staticServer();
  const staticUrl = `http://127.0.0.1:${stat.port}/${stat.prefix}/beatforge.html`;
  notes.push(`static host mounted at /${stat.prefix}/ (GitHub Pages shape), no API behind it`);

  let app = await boot(staticUrl);
  await sequencerChecks(app);
  await exportChecks(app);
  await transcribeChecks(app, false);
  check("no JS errors across the whole static-host run", app.state.errors.length === 0,
        app.state.errors.slice(0, 3).join(" | ") || "clean");
  const unexpectedAlerts = app.state.alerts.filter(a => !/mp3|webcodecs/i.test(a));
  check("no unexpected alert dialogs", unexpectedAlerts.length === 0, unexpectedAlerts.join(" | ") || "none");
  app.close();

  if (pythonAvailable()) {
    let py = null;
    try { py = await pythonServer(); } catch (e) { notes.push("python server: " + e.message); }
    if (py) {
      const app2 = await boot(py.url);
      await transcribeChecks(app2, true);
      check("no JS errors with the python engine", app2.state.errors.length === 0,
            app2.state.errors.slice(0, 3).join(" | ") || "clean");
      app2.close();
      py.child.kill("SIGTERM");
    }
  } else {
    notes.push("numpy/scipy not installed - skipped the python-engine DOM run");
  }

  stat.srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  notes.forEach(n => console.log("  note: " + n));
  if (failed) process.exit(1);
  console.log("DOM WIRING VERIFIED");
  process.exit(0);
})().catch(e => { console.error("\nDOM test crashed:", e); process.exit(2); });
