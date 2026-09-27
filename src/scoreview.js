// Draws the score with VexFlow and shows a cursor at the playback position.
// The whole song is drawn once; only the cursor moves each frame (no redraw).

import { buildScore } from "./score.js";
import { keySignatureName } from "./notation.js";

// All of the following are logical coordinates. Actual drawing is scaled by SCALE.
const STAFF_GAP = 86; // Gap between treble and bass staves (minimum; staffGap widens systems where notes protrude between them)
// Gap between systems. Ledger lines and beams stick out beyond the staff, so the staff height alone isn't enough
const SYSTEM_GAP = 96;
const TOP_MARGIN = 34;
const SIDE_MARGIN = 34; // Left/right margins, as in printed scores
const HEAD_WIDTH = 78; // Room for clef, key signature and time signature (start of each system)
const NOTE_END_PADDING = 10; // Space between the last note and the barline
const SCALE = 1.25; // Larger noteheads for readability
// Max measures per system. Packing in more looks cramped, unlike a printed score
const MAX_MEASURES_PER_SYSTEM = 4;

export class ScoreView {
  /** @param {HTMLElement} host Scrolling container */
  constructor(host) {
    this.host = host;
    this.sheet = document.createElement("div");
    this.sheet.className = "score-sheet";
    this.cursor = document.createElement("div");
    this.cursor.className = "score-cursor";
    this.message = document.createElement("p");
    this.message.className = "score-message";
    this.host.append(this.message, this.sheet, this.cursor);

    this.song = null;
    this.score = null;
    this.placements = [];
    this.getTime = null;
    this.frame = 0;
    this.lastSystem = -1;
    this.lastWidth = 0;
    this.renderToken = 0;
    this.ornaments = true;

    new ResizeObserver(() => {
      // Re-layout only when the width changes. Re-engraving on height changes is heavy.
      if (this.host.clientWidth === this.lastWidth) return;
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => this.#rerender(), 150);
    }).observe(this.host);
  }

  setSong(song) {
    this.song = song;
    this.score = song ? buildScore(song, { ornaments: this.ornaments }) : null;
    this.lastSystem = -1;
    this.#rerender();
  }

  /** Whether to fold ornaments into symbols. Re-layouts when toggled. */
  setOrnaments(enabled) {
    this.ornaments = enabled;
    if (this.song) this.setSong(this.song);
  }

  start(getTime) {
    this.getTime = getTime;
    if (!this.frame) this.frame = requestAnimationFrame(this.#tick);
  }

  freeze(getTime) {
    if (getTime) this.getTime = getTime;
    this.#halt();
    this.#moveCursor();
  }

  clear() {
    this.#halt();
    this.song = null;
    this.score = null;
    this.getTime = null;
    this.#rerender();
  }

  /** Call right after the view becomes visible; while hidden its width is 0 and it can't be laid out. */
  refresh() {
    this.lastWidth = 0;
    this.#rerender();
  }

  #halt() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  // #render is async, so fire-and-forget would lose failures as unhandled rejections.
  // VexFlow load failures are also caught here and shown on screen.
  #rerender() {
    this.#render().catch((error) => {
      console.error(error);
      this.sheet.innerHTML = "";
      this.message.textContent = `楽譜を表示できませんでした: ${error.message}`;
    });
  }

  // ---- Layout -----------------------------------------------------------

  async #render() {
    const width = this.host.clientWidth;
    if (!width) return;
    // If a song switch overlaps a re-layout, the old render can overwrite the new score.
    // Tag each render with a generation and discard it if a newer one started while waiting.
    const token = ++this.renderToken;

    this.lastWidth = width;
    this.sheet.innerHTML = "";
    this.placements = [];
    this.cursor.hidden = true;

    if (!this.score) {
      this.message.textContent = "MIDI ファイルを読み込むと楽譜を表示します。";
      return;
    }
    if (!this.score.ok) {
      this.message.textContent = this.score.reason;
      return;
    }
    this.message.textContent = "";

    const VF = await loadVexFlow();
    if (token !== this.renderToken) return;
    const logicalWidth = width / SCALE;
    // Decide the gap between the two staves for each system and stack them vertically
    let y = TOP_MARGIN;
    const systems = this.#packSystems(logicalWidth).map((items) => {
      const gap = staffGap(items);
      const system = { items, top: y, gap };
      y += gap + SYSTEM_GAP;
      return system;
    });
    const height = y + 50;

    const renderer = new VF.Renderer(this.sheet, VF.Renderer.Backends.SVG);
    renderer.resize(width, height * SCALE);
    const context = renderer.getContext();
    context.scale(SCALE, SCALE);
    context.setFillStyle("#e6ebf3");
    context.setStrokeStyle("#e6ebf3");

    const keyName = keySignatureName(this.score.key.sharps);
    try {
      for (const [index, system] of systems.entries()) {
        this.#drawSystem(VF, context, system, index, keyName);
      }
    } catch (error) {
      // Show it on screen instead of swallowing it. Without knowing which song broke, it can't be fixed.
      console.error(error);
      this.sheet.innerHTML = "";
      this.message.textContent = `楽譜を組めませんでした: ${error.message}`;
      this.placements = [];
      return;
    }

    this.cursor.hidden = false;
    this.#moveCursor();
  }

  /**
   * Pack measures into systems and distribute the spare width proportionally to justify the right edge.
   * Busier measures need more width, or they get squashed and unreadable.
   */
  #packSystems(width) {
    const usable = width - SIDE_MARGIN * 2 - HEAD_WIDTH;
    const density = (measure) =>
      [...measure.treble, ...measure.bass].reduce((sum, voice) => Math.max(sum, voice.length), 0);
    const wanted = this.score.measures.map((measure) => ({
      measure,
      want: Math.max(110, 30 + density(measure) * 26),
    }));

    const systems = [];
    let current = [];
    let used = 0;
    for (const item of wanted) {
      const full = used + item.want > usable || current.length >= MAX_MEASURES_PER_SYSTEM;
      if (current.length && full) {
        systems.push(current);
        current = [];
        used = 0;
      }
      current.push(item);
      used += item.want;
    }
    if (current.length) systems.push(current);

    for (const system of systems) {
      const total = system.reduce((sum, item) => sum + item.want, 0);
      const scale = usable / total;
      let x = SIDE_MARGIN;
      for (const [index, item] of system.entries()) {
        // Only the first measure of each system gets extra width for the clef etc.
        item.width = item.want * scale + (index === 0 ? HEAD_WIDTH : 0);
        item.x = x;
        x += item.width;
      }
    }
    return systems;
  }

  #drawSystem(VF, context, system, systemIndex, keyName) {
    const { top, gap } = system;

    for (const [index, item] of system.items.entries()) {
      const first = index === 0;
      const treble = new VF.Stave(item.x, top, item.width);
      const bass = new VF.Stave(item.x, top + gap, item.width);

      if (first) {
        treble.addClef("treble").addKeySignature(keyName);
        bass.addClef("bass").addKeySignature(keyName);
        if (systemIndex === 0) {
          const { numerator, denominator } = item.measure;
          treble.addTimeSignature(`${numerator}/${denominator}`);
          bass.addTimeSignature(`${numerator}/${denominator}`);
        }
        treble.setMeasure(item.measure.index + 1);
      }
      treble.setContext(context).draw();
      bass.setContext(context).draw();

      const connect = (type) =>
        new VF.StaveConnector(treble, bass).setType(type).setContext(context).draw();
      if (first) {
        connect(VF.StaveConnector.type.BRACE);
        connect(VF.StaveConnector.type.SINGLE_LEFT);
      }
      connect(VF.StaveConnector.type.SINGLE_RIGHT);

      this.#drawMeasure(VF, context, item, treble, bass, keyName);

      // The cursor is a DOM element outside the SVG, so store physical coordinates
      this.placements.push({
        measure: item.measure,
        system: systemIndex,
        x: treble.getNoteStartX() * SCALE,
        width: Math.max(treble.getNoteEndX() - treble.getNoteStartX(), 1) * SCALE,
        top: top * SCALE,
        height: (gap + 68) * SCALE,
      });
    }
  }

  #drawMeasure(VF, context, item, trebleStave, bassStave, keyName) {
    const staves = [
      ["treble", trebleStave],
      ["bass", bassStave],
    ];
    const voices = [];
    const staveOf = [];
    const noteLists = [];
    const staffVoices = [];

    for (const [staff, stave] of staves) {
      const voiceEvents = item.measure[staff];
      const first = voices.length;
      for (const [index, events] of voiceEvents.entries()) {
        // With 2 voices on a staff, the upper voice gets stems up and the lower voice stems down
        const stem = voiceEvents.length > 1 ? (index === 0 ? VF.Stem.UP : VF.Stem.DOWN) : undefined;
        const restKey = restPosition(voiceEvents, index, staff);
        const notes = events.map((event) => toStaveNote(VF, event, staff, stem, restKey));
        const voice = new VF.Voice({ numBeats: item.measure.numerator, beatValue: item.measure.denominator });
        // Dropped remainders can make the total not add up exactly, so use SOFT mode
        voice.setMode(VF.Voice.Mode.SOFT);
        voice.addTickables(notes);
        voice.setStave(stave);
        voices.push(voice);
        staveOf.push(stave);
        noteLists.push({ notes, stem, events });
      }
      staffVoices.push(voices.slice(first));
    }

    // Add only the accidentals needed given the key signature (no sharp on every F# in G major).
    // Accidentals apply per staff, so the upper and lower staves are processed separately
    for (const group of staffVoices) VF.Accidental.applyAccidentals(group, keyName);

    // Clef widths differ between the staves, so align the note start first, then format within the usable width.
    // Subtracting a fixed amount from the measure width overestimated the width at the start of a system
    // (the measure with clef, key and time signatures), and notes spilled past the barline into the next measure.
    const startX = Math.max(trebleStave.getNoteStartX(), bassStave.getNoteStartX());
    trebleStave.setNoteStartX(startX);
    bassStave.setNoteStartX(startX);
    const noteWidth = Math.min(trebleStave.getNoteEndX(), bassStave.getNoteEndX()) - startX - NOTE_END_PADDING;
    // joinVoices only among voices on the same staff. Joining all voices treats notes on the other staff
    // as colliding voices on the same staff, so rests get removed or notes get shifted sideways.
    // format runs on all voices together so horizontal positions line up across both staves.
    const formatter = new VF.Formatter();
    for (const group of staffVoices) formatter.joinVoices(group);
    formatter.format(voices, Math.max(noteWidth, 40));

    // Create beams before drawing notes. VexFlow removes flags from beamed notes,
    // so drawing notes first gives them both a beam and a flag.
    // Without beat groups, the whole measure becomes one beam and the beats can't be read.
    const groups = beamGroups(VF, item.measure);
    const beams = [];
    for (const { notes, stem } of noteLists) {
      const beamable = notes.filter((note) => !note.isRest());
      const config = stem === undefined ? { groups } : { groups, stemDirection: stem, maintainStemDirections: true };
      beams.push(...VF.Beam.generateBeams(beamable, config));
    }

    // Lengths one note can't express are turned into tied notes by score.js
    const ties = [];
    for (const { notes, events } of noteLists) {
      events.forEach((event, i) => {
        if (!event.tieToNext || !notes[i + 1]) return;
        const indexes = event.keys.map((_, k) => k);
        ties.push(
          new VF.StaveTie({ firstNote: notes[i], lastNote: notes[i + 1], firstIndexes: indexes, lastIndexes: indexes }),
        );
      });
    }

    for (const [index, voice] of voices.entries()) voice.draw(context, staveOf[index]);
    for (const beam of beams) beam.setContext(context).draw();
    for (const tie of ties) tie.setContext(context).draw();
  }

  // ---- Cursor -----------------------------------------------------------

  #tick = () => {
    this.frame = requestAnimationFrame(this.#tick);
    this.#moveCursor();
  };

  #moveCursor() {
    if (!this.placements.length) return;
    const now = this.getTime?.() ?? 0;
    const at =
      this.placements.find((p) => now >= p.measure.time && now < p.measure.endTime) ?? this.placements[0];
    const span = Math.max(at.measure.endTime - at.measure.time, 1e-3);
    const ratio = Math.min(Math.max((now - at.measure.time) / span, 0), 1);

    this.cursor.style.transform = `translate(${at.x + at.width * ratio}px, ${at.top - 12}px)`;
    this.cursor.style.height = `${at.height}px`; // Staff gap differs per system

    // Scroll only when the system changes (moving every frame makes it unreadable)
    if (at.system !== this.lastSystem) {
      this.lastSystem = at.system;
      this.host.scrollTo({ top: Math.max(0, at.top - 50), behavior: "smooth" });
    }
  }
}

// ---- Loading VexFlow ----------------------------------------------------

let vexflowPromise = null;
function loadVexFlow() {
  vexflowPromise ??= import("/vendor/vexflow/entry/vexflow.js").then(
    (module) => module.default ?? module.VexFlow ?? module,
  );
  return vexflowPromise;
}

/**
 * Beam groups. Simple meter groups per beat; compound meter (6/8 etc.) per dotted beat.
 */
function beamGroups(VF, measure) {
  const { numerator, denominator } = measure;
  const compound = denominator === 8 && numerator % 3 === 0;
  return compound ? [new VF.Fraction(3, 8)] : [new VF.Fraction(1, denominator === 8 ? 8 : 4)];
}

// ---- Gap between the upper and lower staves ---------------------------------
// Unit is a staff step (one line or space on the staff = 5px).
const HALF_SPACE = 5;
const STAFF_HEIGHT = 40; // Height of one staff
const STEM_STEPS = 7; // Stem length (3.5 spaces)
const diatonic = (key) => {
  const [name, octave] = key.split("/");
  return Number(octave) * 7 + "cdefgab".indexOf(name[0]);
};
const TREBLE_BOTTOM = diatonic("e/4"); // Bottom (1st) line of the treble staff
const BASS_TOP = diatonic("a/3"); // Top (5th) line of the bass staff

/**
 * Gap between the two staves of a system. Estimates how far ledger-line notes and stems protrude
 * down from the treble staff and up from the bass staff, and widens only systems that would collide.
 * With a fixed gap, systems where the left hand plays above middle C (E4), as in the BWV 846 Prelude,
 * have upper-staff beams overlapping lower-staff noteheads.
 */
function staffGap(items) {
  let below = 0;
  let above = 0;
  for (const { measure } of items) {
    measure.treble.forEach((voice, index) => {
      // A single voice (auto stem direction) or the second voice may have stems down (between the staves)
      const stem = measure.treble.length === 1 || index > 0 ? STEM_STEPS : 0;
      for (const event of voice) {
        if (event.rest) continue;
        for (const key of event.keys) below = Math.max(below, TREBLE_BOTTOM - diatonic(key) + stem);
      }
    });
    measure.bass.forEach((voice, index) => {
      // A single voice or the first voice may have stems up (between the staves)
      const stem = measure.bass.length === 1 || index === 0 ? STEM_STEPS : 0;
      for (const event of voice) {
        if (event.rest) continue;
        for (const key of event.keys) above = Math.max(above, diatonic(key) - BASS_TOP + stem);
      }
    });
  }
  return Math.max(STAFF_GAP, STAFF_HEIGHT + (below + above + 3) * HALF_SPACE);
}

const REST_CLEARANCE = 4; // How far to keep a rest from the other voice's notes (a 3rd = 4 steps)
const toKey = (step) => `${"cdefgab"[step % 7]}/${Math.floor(step / 7)}`;

/**
 * Vertical position for rests. With one voice, the middle of the staff. With two, upper-voice rests go
 * above the other voice's highest note and lower-voice rests below its lowest note. A fixed position makes
 * upper-voice rests overlap lower-voice noteheads in measures where the left hand plays above middle C (BWV 846 Prelude).
 */
function restPosition(voiceEvents, index, staff) {
  const lowerVoice = index > 0;
  const fallback = staff === "treble" ? (lowerVoice ? "d/4" : "b/4") : lowerVoice ? "f/2" : "d/3";
  if (voiceEvents.length < 2) return fallback;

  const pick = lowerVoice ? Math.min : Math.max;
  const extent = (events) => {
    const steps = events.filter((event) => !event.rest).flatMap((event) => event.keys.map(diatonic));
    return steps.length ? pick(...steps) : null;
  };
  const other = extent(voiceEvents[lowerVoice ? 0 : 1]);
  if (other === null) return fallback;
  const clear = lowerVoice ? other - REST_CLEARANCE : other + REST_CLEARANCE;
  const own = extent(voiceEvents[index]);
  return toKey(own === null ? clear : pick(own, clear));
}

function toStaveNote(VF, event, staff, stemDirection, restKey) {
  const note = new VF.StaveNote({
    keys: event.rest ? [restKey] : event.keys,
    duration: event.rest ? `${event.duration}r` : event.duration,
    // dots is for the duration (tick) calculation. Dot.buildAndAttach only draws the dot without changing the length,
    // so without this, dotted notes are spaced as undotted and later notes bunch up, misaligned with the other voice
    dots: event.dots ?? 0,
    clef: staff,
    ...(stemDirection === undefined || event.rest ? {} : { stemDirection }),
  });
  for (let i = 0; i < (event.dots ?? 0); i++) VF.Dot.buildAndAttach([note], { all: true });
  // Turn written-out trills and mordents back into symbols
  if (event.ornament) note.addModifier(new VF.Ornament(event.ornament), 0);
  return note;
}
