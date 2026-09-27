// Builds the skeleton of a score from MIDI (drawing is in scoreview.js).
//
// MIDI only records "when it sounded", so turning it into notation takes interpretation:
//   1. Fold written-out ornaments such as trills back into principal note + symbol
//   2. Remove timing fluctuations of the performance (quantize)
//   3. Group simultaneous notes into chords and split overlapping lines into at most 2 voices per staff
//   4. Cut into measures and fill the gaps with rests
//   5. Break durations into note values (whole, dotted quarter, ...)
//
// Step 3 is the key. Without voices, "cutting at every keystroke" writes even sustained notes as runs
// of short notes, which looks cluttered and nothing like the actual score.

import { detectKey, pitchStaffAssigner, spell, staffAssigner } from "./notation.js";

const MAX_VOICES_PER_STAFF = 2;
// If the second voice has less than this share, merge into one voice.
// Splitting voices for just a few notes makes a sustained inner voice overlap the moving one,
// with colliding stems and rests, which is not how real scores are written.
const MIN_SECOND_VOICE_SHARE = 0.25;

// Length treated as an ornament. A run of notes shorter than this fraction of a quarter note
// is taken to be a written-out trill or mordent.
const ORNAMENT_RATIO = 1 / 6;

// Note values. quarters = length in quarter notes. Used longest first.
const NOTE_VALUES = (() => {
  const bases = [
    ["w", 4],
    ["h", 2],
    ["q", 1],
    ["8", 0.5],
    ["16", 0.25],
    ["32", 0.125],
  ];
  const values = [];
  for (const [duration, quarters] of bases) {
    // No double dots. Picking up performance jitter would litter the score with them and make it unreadable
    for (const dots of [1, 0]) {
      values.push({ duration, dots, quarters: quarters * (2 - 2 ** -dots) });
    }
  }
  return values.sort((a, b) => b.quarters - a.quarters);
})();

/** Break a duration (in quarter notes) into a list of note values. If one can't express it, tie them. */
function splitDuration(quarters, shortest) {
  const pieces = [];
  let rest = quarters;
  // Drop the remainder once it is under half the shortest value (otherwise it subdivides forever)
  while (rest >= shortest * 0.5 && pieces.length < 4) {
    const value = NOTE_VALUES.find((v) => v.quarters <= rest + 1e-9);
    if (!value) break;
    pieces.push(value);
    rest -= value.quarters;
  }
  return pieces.length ? pieces : [NOTE_VALUES[NOTE_VALUES.length - 1]];
}

/**
 * Fold written-out ornaments such as trills and mordents into principal note + symbol.
 * Real scores write ornaments as symbols; left as is, there are too many notes to read.
 */
function foldOrnaments(staffNotes, tpq) {
  const limit = tpq * ORNAMENT_RATIO;
  const isShort = (note) => note.endTick - note.startTick < limit;
  const sorted = [...staffNotes].sort((a, b) => a.startTick - b.startTick);
  const out = [];

  let i = 0;
  while (i < sorted.length) {
    if (!isShort(sorted[i])) {
      out.push(sorted[i++]);
      continue;
    }
    let j = i;
    while (j < sorted.length && isShort(sorted[j])) j++;
    const run = sorted.slice(i, j);
    if (run.length < 2) {
      out.push(sorted[i++]);
      continue;
    }

    // The note right after the ornament is the principal note. If the gap is too large, it isn't an ornament
    const next = sorted[j];
    const attached = next && next.startTick - run[run.length - 1].endTick <= limit;
    const principal = attached ? next : run[run.length - 1];
    out.push({
      ...principal,
      startTick: run[0].startTick,
      ornament: run.length >= 4 ? "tr" : "mordent",
    });
    i = attached ? j + 1 : j;
  }
  return out;
}

/** Group notes with the same start and end into chords. */
function toChords(notes) {
  const byRange = new Map();
  for (const note of notes) {
    const key = `${note.start}:${note.end}`;
    const chord = byRange.get(key) ?? { start: note.start, end: note.end, notes: [], ornament: undefined };
    chord.notes.push(note);
    chord.ornament ??= note.ornament;
    byRange.set(key, chord);
  }
  return [...byRange.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Distribute overlapping chords into voices. As in real scores, putting sustained and moving notes
 * in separate voices lets sustained notes keep their true duration.
 */
function assignVoices(chords, step) {
  const voices = [];
  for (const chord of chords) {
    const free = voices.find((voice) => voice[voice.length - 1].end <= chord.start);
    if (free) {
      free.push(chord);
      continue;
    }
    if (voices.length < MAX_VOICES_PER_STAFF) {
      voices.push([chord]);
      continue;
    }
    // No more than 2 voices. Squeeze into the voice that frees up first, shortening its previous note
    const target = voices.reduce((a, b) => (a[a.length - 1].end <= b[b.length - 1].end ? a : b));
    const last = target[target.length - 1];
    last.end = Math.max(chord.start, last.start + step);
    if (last.end <= chord.start) target.push(chord);
  }
  // If the second voice is tiny, merge back into one. Splitting voices for a few notes makes
  // their stems pierce the moving voice's beams, a shape real scores don't have.
  const total = voices.reduce((sum, voice) => sum + voice.length, 0);
  const smallest = Math.min(...voices.map((voice) => voice.length));
  if (voices.length === 2 && smallest < total * MIN_SECOND_VOICE_SHARE) {
    return [flatten(voices.flat(), step)];
  }

  // Higher voice first (the one with stems up)
  const meanPitch = (voice) =>
    voice.reduce((sum, c) => sum + c.notes.reduce((s, n) => s + n.note, 0) / c.notes.length, 0) / voice.length;
  return voices.sort((a, b) => meanPitch(b) - meanPitch(a));
}

/** Flatten into one voice by cutting overlaps at the next keystroke. */
function flatten(chords, step) {
  const sorted = [...chords].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const chord of sorted) {
    const previous = out[out.length - 1];
    if (previous && previous.start === chord.start) {
      // Notes starting at the same position are merged into a chord
      previous.notes.push(...chord.notes);
      previous.end = Math.max(previous.end, chord.end);
      previous.ornament ??= chord.ornament;
      continue;
    }
    if (previous) previous.end = Math.min(previous.end, Math.max(chord.start, previous.start + step));
    out.push({ ...chord, notes: [...chord.notes] });
  }
  return out;
}

/**
 * Build the score model.
 * @param {object} song Return value of parseMidi in smf.js
 * @param {object} options grid = quantize resolution / ornaments = whether to fold ornaments
 * @returns {{measures: Array, key: object, ok: boolean, reason?: string}}
 */
export function buildScore(song, { grid = 16, ornaments = true, forceSplit } = {}) {
  const tpq = song.ticksPerQuarter;
  if (!tpq || !song.measures?.length) {
    return { ok: false, reason: "この MIDI は小節を割り出せない形式です（SMPTE タイムコード）。", measures: [] };
  }
  const notes = song.notes.filter((n) => n.channel !== 9); // Drums are not notated
  if (!notes.length) return { ok: false, reason: "音符がありません。", measures: [] };

  const key = detectKey(notes);
  const step = (tpq * 4) / grid; // Quantize step (ticks)
  const prepare = (staffNotes) => {
    // Fold ornaments before quantizing. Quantizing first rounds ornament notes
    // longer than they are, so they can no longer be recognized.
    const folded = ornaments ? foldOrnaments(staffNotes, tpq) : staffNotes;
    const snap = (tick) => Math.round(tick / step) * step;
    const quantized = folded.map((note) => {
      const start = snap(note.startTick);
      return { ...note, start, end: Math.max(snap(note.endTick), start + step) };
    });
    return assignVoices(toChords(quantized), step);
  };

  const staffOf = forceSplit ? pitchStaffAssigner(forceSplit) : staffAssigner(notes);
  const staffVoices = {};
  for (const staff of ["treble", "bass"]) {
    staffVoices[staff] = prepare(notes.filter((note) => staffOf(note) === staff));
  }

  const measures = song.measures.map((bar, index) => ({
    index,
    tick: bar.tick,
    endTick: bar.tick + bar.ticks,
    time: bar.time,
    endTime: song.measures[index + 1]?.time ?? song.duration,
    numerator: bar.numerator,
    denominator: bar.denominator,
  }));

  const shortest = step / tpq;
  for (const measure of measures) {
    for (const staff of ["treble", "bass"]) {
      const voices = staffVoices[staff].map((voice) => buildVoice(voice, measure, tpq, shortest, key.flats));
      // Two all-rest voices side by side would be nothing but rests, so drop empty voices
      const used = voices.filter((events) => events.some((event) => !event.rest));
      measure[staff] = used.length ? used : [voices[0] ?? fullRest(measure, tpq)];
    }
  }

  return { ok: true, key, measures, ticksPerQuarter: tpq, grid };
}

function fullRest(measure, tpq) {
  const quarters = (measure.endTick - measure.tick) / tpq;
  return [{ rest: true, duration: "w", dots: 0, quarters, pieceQuarters: quarters, tick: measure.tick }];
}

/**
 * Build the note list for one measure of one voice. Notes don't overlap within a voice,
 * so each keeps its true duration and the gaps are filled with rests.
 */
function buildVoice(voiceChords, measure, tpq, shortest, flats) {
  const { tick: from, endTick: to } = measure;
  const inside = voiceChords.filter((c) => c.start < to && c.end > from);
  if (!inside.length) return fullRest(measure, tpq);

  const events = [];
  let cursor = from;
  for (const chord of inside) {
    const start = Math.max(chord.start, from);
    const end = Math.min(chord.end, to);
    if (start > cursor) events.push({ rest: true, quarters: (start - cursor) / tpq, tick: cursor });

    // Remove duplicate pitches and sort ascending (VexFlow takes chords bottom-up)
    const midi = [...new Set(chord.notes.map((n) => n.note))].sort((a, b) => a - b);
    const spelled = midi.map((n) => spell(n, flats));
    events.push({
      rest: false,
      tick: start,
      quarters: (end - start) / tpq,
      keys: spelled.map(toVexKey),
      accidentals: spelled.map((s) => s.alter),
      midi,
      ornament: chord.ornament,
    });
    cursor = end;
  }
  if (cursor < to) events.push({ rest: true, quarters: (to - cursor) / tpq, tick: cursor });

  // Lengths no single note can express (e.g. 7 sixteenths) are tied. Rounding to the nearest note
  // makes the voice total differ from the measure length, and overflowing notes spill into the next measure.
  // Odd lengths after quantizing aren't performance jitter; the score really has notes that long
  // (left-hand E in the BWV 846 Prelude = 16th rest + dotted 8th tied to a quarter).
  return events.flatMap((event) =>
    splitDuration(event.quarters, shortest).map((piece, index, pieces) => ({
      ...event,
      duration: piece.duration,
      dots: piece.dots,
      pieceQuarters: piece.quarters,
      // Attach the ornament symbol to the first note only
      ornament: index === 0 ? event.ornament : undefined,
      tieToNext: !event.rest && index < pieces.length - 1,
    })),
  );
}

// Convert to VexFlow key notation "c#/4". Accidentals are drawn separately via Accidental.
function toVexKey(spelled) {
  const accidental = spelled.alter === 1 ? "#" : spelled.alter === -1 ? "b" : "";
  return `${spelled.letter}${accidental}/${spelled.octave}`;
}
