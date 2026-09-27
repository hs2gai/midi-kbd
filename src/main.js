import { loadSfz } from "./sfz.js";
import { SfzSampler } from "./sampler.js";
import { FxChain } from "./fx.js";
import { Keyboard } from "./keyboard.js";
import { connectMidi, isSupported } from "./midi.js";
import { parseMidi } from "./smf.js";
import { MidiPlayer } from "./player.js";
import { NoteFall } from "./notefall.js";
import { StaffRoll } from "./staffroll.js";
import { ScoreView } from "./scoreview.js";

const INSTRUMENT_DIR = "/sfz/SplendidGrandPiano/";
const INSTRUMENT_FILE = "Splendid Grand Piano.sfz";

// Instrument-side knobs. Equivalent to sforzando's CONTROLS tab; values are sent straight through as CCs.
const CC_CONTROLS = [
  { cc: 7, label: "Volume", format: (v) => `${v}` },
  { cc: 10, label: "Pan", format: (v) => (v === 64 ? "C" : v < 64 ? `L${64 - v}` : `R${v - 64}`) },
  { cc: 70, label: "Resonance", format: (v) => `${Math.round((v / 127) * 100)}%` },
  { cc: 72, label: "Release", format: (v) => `${(2 * (v / 127)).toFixed(2)}s` },
  { cc: 99, label: "Veltrack", format: (v) => `${Math.round((v / 127) * 100)}%` },
  { cc: 64, label: "Sus.Pedal", format: (v) => (v >= 64 ? "DOWN" : v > 0 ? "half" : "up") },
];

// Equivalent to sforzando's EFFECTS tab. `key` is a key of FxChain.params.
const FX_CONTROLS = [
  { section: "REVERB", key: "send", label: "Send", min: 0, max: 1, step: 0.01, unit: "%" },
  { section: "REVERB", key: "decay", label: "Decay", min: 0.2, max: 8, step: 0.1, unit: "s" },
  { section: "REVERB", key: "size", label: "Size", min: 0.2, max: 2.5, step: 0.05, unit: "x" },
  { section: "REVERB", key: "predelay", label: "Predelay", min: 0, max: 0.15, step: 0.001, unit: "ms" },
  { section: "REVERB", key: "diffusion", label: "Diffusion", min: 0, max: 1, step: 0.01, unit: "%" },
  { section: "REVERB", key: "width", label: "Width", min: 0, max: 1, step: 0.01, unit: "%" },
  { section: "DAMPING", key: "damping", label: "Hi Damp", min: 500, max: 18000, step: 100, unit: "Hz" },
  { section: "EQUALIZER", key: "loFreq", label: "Lo Freq", min: 40, max: 600, step: 5, unit: "Hz" },
  { section: "EQUALIZER", key: "loGain", label: "Lo Gain", min: -18, max: 18, step: 0.5, unit: "dB" },
  { section: "EQUALIZER", key: "hiFreq", label: "Hi Freq", min: 1500, max: 12000, step: 100, unit: "Hz" },
  { section: "EQUALIZER", key: "hiGain", label: "Hi Gain", min: -18, max: 18, step: 0.5, unit: "dB" },
  { section: "OUTPUT", key: "master", label: "Level", min: 0, max: 1.5, step: 0.01, unit: "%" },
];

// For trying out sounds on the computer keyboard. Bottom row = C3 octave, top row = C4 octave.
const TYPING_KEYS = {
  KeyZ: 48, KeyS: 49, KeyX: 50, KeyD: 51, KeyC: 52, KeyV: 53, KeyG: 54,
  KeyB: 55, KeyH: 56, KeyN: 57, KeyJ: 58, KeyM: 59,
  KeyQ: 60, Digit2: 61, KeyW: 62, Digit3: 63, KeyE: 64, KeyR: 65, Digit5: 66,
  KeyT: 67, Digit6: 68, KeyY: 69, Digit7: 70, KeyU: 71, KeyI: 72,
};

const SETTINGS_KEY = "midi-keyboard/settings";
const VIEW_KEY = "midi-keyboard/view";
// The sustain pedal is transient performance state, so it is not saved
const TRANSIENT_CC = new Set([64]);

const $ = (id) => document.getElementById(id);
const formatFx = (control, value) =>
  ({
    "%": () => `${Math.round(value * 100)}%`,
    s: () => `${value.toFixed(1)}s`,
    x: () => `${value.toFixed(2)}x`,
    ms: () => `${Math.round(value * 1000)}ms`,
    Hz: () => `${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : Math.round(value)}Hz`,
    dB: () => `${value > 0 ? "+" : ""}${value.toFixed(1)}dB`,
  })[control.unit]();

const app = {
  ctx: null,
  fx: null,
  sampler: null,
  player: null,
  keyboard: null,
  notefall: null,
  staffroll: null,
  scoreview: null,
  view: localStorage.getItem(VIEW_KEY) ?? "notefall",
  heldTypingKeys: new Set(),
  readyText: "", // Text shown once loading finishes (regions / samples)
  waitingForGesture: false, // Loading is done, but we are waiting for a user gesture to enable sound
};

const formatTime = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

// ---- Saving / restoring settings --------------------------------------------

let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cc = {};
    for (const control of CC_CONTROLS) {
      if (!TRANSIENT_CC.has(control.cc)) cc[control.cc] = app.sampler.cc[control.cc];
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ fx: app.fx.params, cc }));
    $("reset").hidden = false;
  }, 300);
}

/** Applies the previous settings to the instrument and effects. Call this before building the UI. */
function restoreSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return;
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch (error) {
    // Don't silently swallow a corrupt value: log why, then discard it and fall back to defaults
    console.warn("Could not read saved settings; falling back to defaults", error);
    localStorage.removeItem(SETTINGS_KEY);
    return;
  }
  // Pick up only known keys, even if unknown keys or an old format are mixed in
  const fx = Object.fromEntries(
    Object.entries(saved.fx ?? {}).filter(([key]) => key in app.fx.params && Number.isFinite(saved.fx[key])),
  );
  app.fx.setAll(fx);
  for (const [cc, value] of Object.entries(saved.cc ?? {})) {
    if (Number.isInteger(value) && value >= 0 && value <= 127) app.sampler.controlChange(Number(cc), value);
  }
  $("reset").hidden = false;
}

function resetSettings() {
  localStorage.removeItem(SETTINGS_KEY);
  location.reload();
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

// ---- Startup ----------------------------------------------------------------

// Due to autoplay restrictions, the AudioContext stays suspended until the user interacts with the page (MIDI key presses don't count)
const audible = () => app.ctx?.state === "running";

/** Enables sound in response to a click or key press. */
function unlockAudio() {
  if (app.ctx && !audible()) app.ctx.resume();
}

/** Shows the "loaded" status. If sound is not yet enabled, prompts the user to interact. */
function showReady() {
  app.waitingForGesture = !audible();
  setStatus(
    app.waitingForGesture ? "準備完了 — 画面をクリックするかキーを押すと音が出ます" : `準備完了 — ${app.readyText}`,
    "ok",
  );
}

async function boot() {
  $("start").disabled = true;
  try {
    app.ctx = new AudioContext({ latencyHint: "interactive" });
    // If autoplay is allowed, sound becomes available right here. If not, resume() won't settle
    // until the user interacts, so continue loading without waiting for it
    app.ctx.resume();
    app.ctx.addEventListener("statechange", () => {
      if (app.waitingForGesture && audible()) showReady();
    });

    setStatus("SFZ を解析中…");
    const sfz = await loadSfz(INSTRUMENT_DIR + encodeURIComponent(INSTRUMENT_FILE));

    app.fx = new FxChain(app.ctx);
    app.sampler = new SfzSampler(app.ctx, sfz, INSTRUMENT_DIR, app.fx.input);
    app.player = new MidiPlayer(app.ctx, app.sampler, {
      onTick: updateTransport,
      onStateChange: () => {
        updateTransport();
        syncViews();
      },
      onNote: (note, on) => app.keyboard.setActive(note, on),
      onControlChange: syncCcSlider, // Keep the pedal knob showing the real state during playback too
    });

    restoreSettings();
    buildFxPanel();
    buildCcPanel();

    const unique = new Set(sfz.regions.map((r) => r.sample)).size;
    setStatus(`サンプル読み込み中… 0 / ${unique}`);
    await app.sampler.load(({ done, total, bytes }) => {
      $("progress").style.width = `${(done / total) * 100}%`;
      setStatus(`サンプル読み込み中… ${done} / ${total}`);
      $("memory").textContent = `${(bytes / 1024 / 1024).toFixed(0)} MB`;
    });

    $("progress-bar").hidden = true;
    app.readyText = `${sfz.regions.length} regions / ${unique} samples`;
    showReady();
    $("start").hidden = true;

    await loadPresets();
    await setupMidi();
  } catch (error) {
    setStatus(error.message, "error");
    $("start").hidden = false; // Even if loading started automatically, allow retrying from the button
    $("start").disabled = false;
    throw error;
  }
}

async function setupMidi() {
  if (!isSupported()) {
    $("midi-ports").textContent = "Web MIDI 非対応ブラウザ（画面の鍵盤と PC キーボードは使えます）";
    return;
  }
  try {
    await connectMidi({
      onNoteOn: playNote,
      onNoteOff: stopNote,
      onControlChange: (cc, value) => {
        app.sampler.controlChange(cc, value);
        syncCcSlider(cc, value);
        if (cc === 123 || cc === 120) releaseAll();
      },
      onPitchBend: (value) => app.sampler.setPitchBend((value / 8192) * 200),
      onPorts: (ports) => {
        $("midi-ports").textContent = ports.length
          ? ports.map((p) => p.name).join(" / ")
          : "MIDI 機器が見つかりません（接続したら自動で認識します）";
      },
    });
  } catch (error) {
    $("midi-ports").textContent = error.message;
  }
}

// ---- Note playback ----------------------------------------------------------

function playNote(note, velocity) {
  if (!audible()) {
    // Drop MIDI key presses while suspended; if accepted, they would all sound at once when audio starts.
    // The on-screen keyboard and computer keyboard are user gestures, so use them to resume and play
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    unlockAudio();
  }
  app.sampler.noteOn(note, velocity);
  app.keyboard.setActive(note, true);
  updateMeters();
}

function stopNote(note) {
  app.sampler.noteOff(note);
  app.keyboard.setActive(note, false);
}

function releaseAll() {
  app.sampler.allNotesOff();
  app.keyboard.clear();
}

function updateMeters() {
  $("voices").textContent = `${app.sampler.activeVoices} / ${app.sampler.maxVoices}`;

  // Output latency = Web Audio processing buffer (baseLatency) + OS/device side (outputLatency).
  // It changes when the output device is switched, so re-measure every time. It is 0 in browsers without outputLatency
  const ms = (seconds) => `${Math.round(seconds * 1000)} ms`;
  const base = app.ctx.baseLatency ?? 0;
  const output = app.ctx.outputLatency ?? 0;
  $("latency").textContent = ms(base + output);
  $("latency-meter").title = `音の出力側の遅延（処理 ${ms(base)} + 出力 ${ms(output)}）`;
}

// ---- Building the UI --------------------------------------------------------

function buildFxPanel() {
  const sections = new Map();
  for (const control of FX_CONTROLS) {
    if (!sections.has(control.section)) {
      const box = document.createElement("section");
      box.className = "panel";
      box.innerHTML = `<h2>${control.section}</h2><div class="knobs"></div>`;
      sections.set(control.section, box.querySelector(".knobs"));
      $("fx").append(box);
    }
    const value = app.fx.params[control.key];
    const row = document.createElement("label");
    row.className = "knob";
    row.innerHTML = `
      <span class="knob-label">${control.label}</span>
      <input type="range" min="${control.min}" max="${control.max}" step="${control.step}" value="${value}">
      <output>${formatFx(control, value)}</output>`;
    const input = row.querySelector("input");
    const output = row.querySelector("output");
    input.addEventListener("input", () => {
      const next = Number(input.value);
      app.fx.set(control.key, next);
      output.textContent = formatFx(control, next);
      saveSettings();
    });
    sections.get(control.section).append(row);
  }
}

function buildCcPanel() {
  for (const control of CC_CONTROLS) {
    const value = app.sampler.cc[control.cc];
    const row = document.createElement("label");
    row.className = "knob";
    row.dataset.cc = String(control.cc);
    row.innerHTML = `
      <span class="knob-label">${control.label}<em>CC${control.cc}</em></span>
      <input type="range" min="0" max="127" step="1" value="${value}">
      <output>${control.format(value)}</output>`;
    const input = row.querySelector("input");
    input.addEventListener("input", () => {
      const next = Number(input.value);
      app.sampler.controlChange(control.cc, next);
      row.querySelector("output").textContent = control.format(next);
      saveSettings();
    });
    $("instrument-knobs").append(row);
  }

  const veltrack = $("instrument-knobs").querySelector('[data-cc="99"] input');
  const applyVeltrack = () => (app.sampler.veltrack = Number(veltrack.value) / 127);
  veltrack.addEventListener("input", applyVeltrack);
  applyVeltrack();

  const resonance = $("instrument-knobs").querySelector('[data-cc="70"] input');
  resonance.addEventListener("input", () => (app.sampler.resonance = Number(resonance.value) > 0));
}

// Reflect CCs received over MIDI in the slider display
function syncCcSlider(cc, value) {
  const row = $("instrument-knobs").querySelector(`[data-cc="${cc}"]`);
  if (!row) return;
  row.querySelector("input").value = String(value);
  row.querySelector("output").textContent = CC_CONTROLS.find((c) => c.cc === cc).format(value);
  if (cc === 99) app.sampler.veltrack = value / 127;
  if (cc === 70) app.sampler.resonance = value > 0;
  if (!TRANSIENT_CC.has(cc)) saveSettings();
}

// ---- MIDI file playback -----------------------------------------------------

// View switching table. `id` is the DOM element, `key` is the instance name on `app`.
const VIEWS = {
  notefall: { id: "notefall", key: "notefall" },
  staff: { id: "staffroll", key: "staffroll" },
  score: { id: "score", key: "scoreview" },
};

// Call only when the playback state changes. Only the visible view runs its rAF loop.
function syncViews() {
  const { player, view } = app;
  const active = app[VIEWS[view].key];

  for (const [name, entry] of Object.entries(VIEWS)) {
    $(entry.id).hidden = name !== view;
    if (name !== view) app[entry.key].clear(); // Stop the rAF loop of views moved to the background
  }

  if (!player?.song) {
    active.clear();
    return;
  }
  if (view === "notefall") active.setNotes(player.song.notes);
  else active.setSong(player.song);

  const time = () => player.currentTime;
  // When paused or stopped, just stop the rAF loop and leave the drawing at that position
  if (player.playing) active.start(time);
  else active.freeze(time);
}

function setView(view) {
  app.view = VIEWS[view] ? view : "notefall";
  localStorage.setItem(VIEW_KEY, app.view);
  for (const button of $("view-switch").children) {
    button.classList.toggle("active", button.dataset.view === app.view);
  }
  // While hidden, its size is 0 and it can't be laid out or drawn, so show it first and then re-measure
  $(VIEWS[app.view].id).hidden = false;
  const active = app[VIEWS[app.view].key];
  if (active.resize) active.resize();
  else active.refresh();
  syncViews();
}

function updateTransport() {
  const { player } = app;
  $("transport").hidden = !player?.song;
  if (!player?.song) return;
  const position = player.currentTime;
  $("song-name").textContent = player.song.name;
  $("play").textContent = player.playing ? "❚❚" : "▶";
  $("seek-fill").style.width = `${(position / player.duration) * 100}%`;
  $("time").textContent = `${formatTime(position)} / ${formatTime(player.duration)}`;
}

/** Fetches the .mid files under midi/ from the server and lists them in the dropdown. */
async function loadPresets() {
  const response = await fetch("/api/midi");
  if (!response.ok) return;
  const presets = await response.json();
  const select = $("presets");
  const groups = new Map();
  for (const preset of presets) {
    if (!groups.has(preset.folder)) {
      const group = document.createElement("optgroup");
      group.label = preset.folder;
      groups.set(preset.folder, group);
      select.append(group);
    }
    const option = document.createElement("option");
    option.value = preset.url;
    option.textContent = preset.name;
    if (preset.credit) option.dataset.credit = JSON.stringify(preset.credit);
    groups.get(preset.folder).append(option);
  }
  select.hidden = presets.length === 0;
}

/** Shows author, source and license only while a CC BY-style preset is playing. Pass null to hide it. */
function showCredit(credit) {
  const box = $("credit");
  box.hidden = !credit;
  if (!credit) return;
  // credit.json is hand-written, but only link http(s) URLs so that things like javascript: never get executed
  const link = (href, text) =>
    /^https?:\/\//i.test(href)
      ? Object.assign(document.createElement("a"), { href, textContent: text, target: "_blank", rel: "noopener" })
      : text;
  box.replaceChildren("MIDI: ", link(credit.source, credit.author), " / ", link(credit.licenseUrl, credit.license));
}

async function loadMidiUrl(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`読み込めません (${response.status})`);
  await loadSong(await response.arrayBuffer(), label);
}

async function loadMidiFile(file) {
  if (!app.player) {
    setStatus("先に「▶ 開始」を押して音源を読み込んでください。", "error");
    return;
  }
  try {
    await loadSong(await file.arrayBuffer(), file.name.replace(/\.midi?$/i, ""));
    $("presets").value = ""; // A dropped file is not a preset
    showCredit(null);
  } catch (error) {
    // Dropping an unreadable file is an expected user mistake. Log the cause and show it on screen.
    console.error(error);
    setStatus(`${file.name}: ${error.message}`, "error");
  }
}

async function loadSong(buffer, label) {
  const song = parseMidi(buffer, label);
  app.player.load(song);
  setStatus(`${song.name} — ${song.notes.length} notes / ${formatTime(song.duration)}`, "ok");
  app.player.play();
}

// Counting dragenter/dragleave gets out of balance when a drop happens outside the window
// or the drag is aborted, leaving the overlay stuck on screen.
// Hiding it "once dragover stops arriving" always recovers on its own, even if events are missed.
// (Per the spec, dragover fires at least every 350ms during a drag)
let overlayTimer = 0;
const hideOverlay = () => {
  clearTimeout(overlayTimer);
  $("drop-overlay").hidden = true;
};

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  $("drop-overlay").hidden = false;
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(hideOverlay, 500);
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) hideOverlay(); // Left the window
});
window.addEventListener("dragend", hideOverlay);
window.addEventListener("blur", hideOverlay);
window.addEventListener("drop", (event) => {
  event.preventDefault();
  hideOverlay();
  const file = event.dataTransfer?.files?.[0];
  if (file) loadMidiFile(file);
});

// For cases where drag-and-drop isn't available, also let the hint text open a file picker
$("presets").addEventListener("change", async (event) => {
  const url = event.target.value;
  if (!url || !app.player) return;
  const option = event.target.selectedOptions[0];
  const label = option.textContent;
  try {
    await loadMidiUrl(url, label);
    showCredit(option.dataset.credit ? JSON.parse(option.dataset.credit) : null);
  } catch (error) {
    console.error(error);
    setStatus(`${label}: ${error.message}`, "error");
  }
});

$("browse").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadMidiFile(file);
  event.target.value = ""; // So the same file can be selected again
});

$("play").addEventListener("click", () => {
  if (!app.player?.song) return;
  if (app.player.playing) {
    app.player.pause();
    app.keyboard.clear();
  } else {
    app.player.play();
  }
});
$("stop").addEventListener("click", () => {
  app.player?.stop();
  app.keyboard.clear();
});
$("eject").addEventListener("click", () => {
  app.player?.eject();
  app.keyboard.clear();
});
$("skip-drums").addEventListener("change", (event) => {
  if (app.player) app.player.skipDrums = event.target.checked;
});
$("seek").addEventListener("click", (event) => {
  if (!app.player?.song) return;
  const box = event.currentTarget.getBoundingClientRect();
  app.player.seek(((event.clientX - box.left) / box.width) * app.player.duration);
  app.keyboard.clear();
});

// ---- Input ------------------------------------------------------------------

app.keyboard = new Keyboard($("keyboard"), {
  onNoteOn: (note, velocity) => app.sampler && playNote(note, velocity),
  onNoteOff: (note) => app.sampler && stopNote(note),
});
app.notefall = new NoteFall($("notefall"), app.keyboard);
app.staffroll = new StaffRoll($("staffroll"));
app.scoreview = new ScoreView($("score"));
setView(app.view);

$("view-switch").addEventListener("click", (event) => {
  const view = event.target.dataset?.view;
  if (view) setView(view);
});

window.addEventListener("keydown", (event) => {
  if (!app.sampler || event.repeat || event.metaKey || event.ctrlKey) return;
  if (event.code === "Space") {
    event.preventDefault();
    app.sampler.controlChange(64, 127);
    syncCcSlider(64, 127);
    return;
  }
  const note = TYPING_KEYS[event.code];
  if (note === undefined || app.heldTypingKeys.has(event.code)) return;
  app.heldTypingKeys.add(event.code);
  playNote(note, 90);
});

window.addEventListener("keyup", (event) => {
  if (!app.sampler) return;
  if (event.code === "Space") {
    app.sampler.controlChange(64, 0);
    syncCcSlider(64, 0);
    return;
  }
  const note = TYPING_KEYS[event.code];
  if (note === undefined || !app.heldTypingKeys.delete(event.code)) return;
  stopNote(note);
});

// Start the parameter panel collapsed at phone width and keep it always open at desktop width (same width as the CSS @media)
const narrowScreen = matchMedia("(max-width: 640px)");
const syncParamsPanel = () => ($("params").open = !narrowScreen.matches);
narrowScreen.addEventListener("change", syncParamsPanel);
syncParamsPanel();

setInterval(() => app.sampler && updateMeters(), 250);
$("start").addEventListener("click", boot);
for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, unlockAudio, { capture: true });

// On desktop, load the instrument as soon as the page opens. On phones and touch devices, keep the
// "▶ 開始" (Start) button so that merely opening the page doesn't use about 75 MB
if (!matchMedia("(max-width: 640px), (pointer: coarse)").matches) {
  $("start").hidden = true;
  boot();
}
$("reset").addEventListener("click", resetSettings);

// Expose the instrument so it can be driven directly from DevTools (e.g. app.sampler.noteOn(60, 100))
window.app = app;
