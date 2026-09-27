// Musical decisions shared by the staff roll and the sheet-music view.
// MIDI note numbers don't distinguish C# from Db, so the spelling is chosen from the key.

// Pitch spelling. Sharp vs. flat spelling changes the diatonic step and the accidental.
// e.g. C# derives from C (step 0, sharp); Db derives from D (step 1, flat).
const SHARP_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const SHARP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const FLAT_STEP = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
const FLAT_ALTER = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];

const LETTERS = ["c", "d", "e", "f", "g", "a", "b"];

// Major/minor key profiles (Krumhansl-Schmuckler).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Key signature per tonic (already mapped to major). Positive = number of sharps, negative = number of flats.
const KEY_SIGNATURES = new Map([
  [0, 0], // C
  [7, 1], // G
  [2, 2], // D
  [9, 3], // A
  [4, 4], // E
  [11, 5], // B
  [6, -6], // Treat F# as Gb (6 flats is easier to read)
  [1, -5], // Db
  [8, -4], // Ab
  [3, -3], // Eb
  [10, -2], // Bb
  [5, -1], // F
]);

/**
 * Estimate the key from how long each pitch class sounds, since many MIDI files lack a key signature meta event.
 * @returns {{tonic: number, minor: boolean, sharps: number, flats: boolean}}
 */
export function detectKey(notes) {
  const histogram = new Array(12).fill(0);
  for (const note of notes) histogram[note.note % 12] += note.end - note.start;

  let best = { score: -Infinity, tonic: 0, minor: false };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
      let score = 0;
      for (let i = 0; i < 12; i++) score += histogram[(tonic + i) % 12] * profile[i];
      if (score > best.score) best = { score, tonic, minor };
    }
  }
  // Map minor keys to their relative major before looking up the key signature (A minor -> C major)
  const relativeMajor = best.minor ? (best.tonic + 3) % 12 : best.tonic;
  const sharps = KEY_SIGNATURES.get(relativeMajor) ?? 0;
  return { tonic: best.tonic, minor: best.minor, sharps, flats: sharps < 0 };
}

/** Key signature name for VexFlow ("C" / "Bb"; uses major names, not "F#m"). */
export function keySignatureName(sharps) {
  const majors = { 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#" };
  const flatMajors = { 1: "F", 2: "Bb", 3: "Eb", 4: "Ab", 5: "Db", 6: "Gb", 7: "Cb" };
  return sharps >= 0 ? (majors[sharps] ?? "C") : (flatMajors[-sharps] ?? "C");
}

/**
 * Spell a note number as a pitch name.
 * @returns {{letter: string, alter: number, octave: number, diatonic: number}}
 *   diatonic is the white-key index counted from C0. It determines the vertical position on the staff.
 */
export function spell(midiNote, flats) {
  const step = (flats ? FLAT_STEP : SHARP_STEP)[midiNote % 12];
  const alter = (flats ? FLAT_ALTER : SHARP_ALTER)[midiNote % 12];
  // Correct for flat spellings wrapping below C (Cb) and sharp spellings going above B (B#)
  const rawOctave = Math.floor(midiNote / 12) - 1;
  return { letter: LETTERS[step], alter, octave: rawOctave, diatonic: rawOctave * 7 + step };
}

const MIDDLE_C = 60;
// Search range for the split point when dividing notes between the staves by pitch.
// Outside this range one staff ends up practically empty and hard to read.
const SPLIT_MIN = 48; // C3
const SPLIT_MAX = 72; // C5

/**
 * Find the boundary that splits the pitch histogram into two clusters (Otsu's method).
 * A fixed middle C split puts the left hand on the treble staff in MIDI transposed
 * up an octave, so sustained bass notes and the moving voice end up sharing one staff.
 */
function bestSplit(notes) {
  // Weight by note count. Weighting by duration makes sustained bass notes too heavy,
  // lowering the split so even the bass drifts to the upper staff (seen in Prelude1).
  const histogram = new Array(128).fill(0);
  for (const note of notes) histogram[note.note]++;

  let best = { score: -1, split: MIDDLE_C };
  for (let split = SPLIT_MIN; split <= SPLIT_MAX; split++) {
    let lowCount = 0;
    let lowSum = 0;
    let highCount = 0;
    let highSum = 0;
    for (let pitch = 0; pitch < 128; pitch++) {
      if (!histogram[pitch]) continue;
      if (pitch < split) {
        lowCount += histogram[pitch];
        lowSum += pitch * histogram[pitch];
      } else {
        highCount += histogram[pitch];
        highSum += pitch * histogram[pitch];
      }
    }
    if (!lowCount || !highCount) continue;
    // The farther apart the two cluster means, the better the split
    const score = lowCount * highCount * (highSum / highCount - lowSum / lowCount) ** 2;
    if (score > best.score) best = { score, split };
  }
  return best.split;
}

// Part = track + channel pair. Some MIDI files put the hands on separate tracks but the same channel
// (e.g. the BWV 846 Prelude from piano-midi.de), so channel alone can't separate them.
const partOf = (note) => `${note.track ?? 0}:${note.channel}`;
// If splitting by part leaves one staff below this share, fall back to splitting by pitch.
// In a piece where the left hand also plays high (Ravel's Jeux d'eau), the left hand went to the
// treble staff too, leaving the bass staff almost empty (0.7%) and cramming both hands into the upper one.
const MIN_STAFF_SHARE = 0.1;

/**
 * Returns a function assigning notes to the upper/lower staff by each part's mean pitch.
 * Assigning by individual pitch makes one voice hop between the staves and become unreadable,
 * so this is preferred when usable.
 * Returns null for MIDI with only one part, or when the result is lopsided.
 *
 * @returns {((note) => "treble" | "bass") | null}
 */
export function partStaffAssigner(notes) {
  const perPart = new Map();
  for (const note of notes) {
    const entry = perPart.get(partOf(note)) ?? { sum: 0, count: 0 };
    entry.sum += note.note;
    entry.count++;
    perPart.set(partOf(note), entry);
  }
  if (perPart.size < 2) return null;

  const trebleParts = [...perPart.entries()].filter(([, e]) => e.sum / e.count >= MIDDLE_C);
  const trebleCount = trebleParts.reduce((sum, [, e]) => sum + e.count, 0);
  const minority = Math.min(trebleCount, notes.length - trebleCount);
  if (minority < notes.length * MIN_STAFF_SHARE) return null;

  const treble = new Set(trebleParts.map(([part]) => part));
  return (note) => (treble.has(partOf(note)) ? "treble" : "bass");
}

/** Returns a function assigning notes to the upper/lower staff around the given pitch. */
export function pitchStaffAssigner(split) {
  return (note) => (note.note >= split ? "treble" : "bass");
}

/** Candidate split points for splitting by pitch (every integer in the search range). */
export function splitCandidates() {
  return Array.from({ length: SPLIT_MAX - SPLIT_MIN + 1 }, (_, i) => SPLIT_MIN + i);
}

/**
 * Returns a function deciding whether a note goes on the upper or lower staff of the grand staff.
 * When parts can't separate them, the split point is estimated from the pitch distribution.
 *
 * @returns {(note: {note: number, channel: number, track?: number}) => "treble" | "bass"}
 */
export function staffAssigner(notes) {
  return partStaffAssigner(notes) ?? pitchStaffAssigner(bestSplit(notes));
}

export { bestSplit };
