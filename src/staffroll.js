// Staff-roll view. Places notes at their correct line/space positions on a grand staff (treble + bass clef)
// and scrolls them right to left with playback. Note length maps directly to width, so rhythm is readable too.
// No stems, beams or rests (not a real transcription, just "a piano roll shaped like a score").

import { detectKey, spell, staffAssigner } from "./notation.js";

const WINDOW = 6.0; // Seconds visible on screen
const NOW_RATIO = 0.22; // Position of "now" (fraction from the left)
const HUES = [208, 168, 262, 32, 140, 318, 190, 92]; // Same palette as the note fall

// Bottom line of each staff: E4 for treble clef, G2 for bass clef.
const TREBLE_BOTTOM = 4 * 7 + 2; // E4
const BASS_BOTTOM = 2 * 7 + 4; // G2

// Vertical position in "units" of lineGap. The treble bottom line is 0; larger is lower.
//   y = trebleBottomY + unit * lineGap
// The bass bottom line is 10 units below (4 within the staff + 6 between staves).
const unitOf = (placed) => (placed.treble ? 0 : 10) - placed.offset / 2;

/** Unit range that fits the staves and every note. Adds a notehead's thickness as margin. */
function unitRange(placed) {
  let min = -4; // Top (5th) line of the treble staff
  let max = 10; // Bottom (1st) line of the bass staff
  for (const note of placed) {
    const unit = unitOf(note);
    if (unit < min) min = unit;
    if (unit > max) max = unit;
  }
  return { min: min - 0.6, max: max + 0.6 };
}

export class StaffRoll {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.song = null;
    this.placed = [];
    this.getTime = null;
    this.frame = 0;

    this.resize();
    new ResizeObserver(() => {
      this.resize();
      if (!this.frame) this.#draw();
    }).observe(canvas);
    this.#draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const clamp = (v) => Math.min(Math.max(1, Math.round(v)), 8000);
    this.width = clamp(this.canvas.clientWidth);
    this.height = clamp(this.canvas.clientHeight);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#layout();
  }

  setSong(song) {
    this.song = song;
    this.#place();
    this.#layout();
  }

  start(getTime) {
    this.getTime = getTime;
    if (!this.frame) this.frame = requestAnimationFrame(this.#render);
  }

  freeze(getTime) {
    if (getTime) this.getTime = getTime;
    this.#halt();
    this.#draw();
  }

  clear() {
    this.#halt();
    this.song = null;
    this.placed = [];
    this.getTime = null;
    this.#draw();
  }

  #halt() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  // Precompute each note's staff, diatonic step and accidental.
  // Doing this every frame is heavy, so it runs once on load.
  #place() {
    const notes = this.song?.notes ?? [];
    if (!notes.length) {
      this.placed = [];
      this.unitRange = unitRange([]);
      return;
    }
    const { flats } = detectKey(notes);
    const staffOf = staffAssigner(notes);

    const placed = notes.map((note) => {
      const { alter, diatonic } = spell(note.note, flats);
      const treble = staffOf(note) === "treble";
      return {
        ...note,
        treble,
        // Height in staff steps (lines and spaces) counted from the staff's bottom line
        offset: diatonic - (treble ? TREBLE_BOTTOM : BASS_BOTTOM),
        accidental: alter === 1 ? "♯" : alter === -1 ? "♭" : "",
      };
    });

    this.placed = placed;
    this.unitRange = unitRange(placed);
  }

  // Decide the staves' vertical position and size. Pick the largest size that fits every note
  // in the song's range (covering A0-C8 even for piano music makes the staff too small,
  // so only the range actually played is considered).
  #layout() {
    const { min, max } = this.unitRange ?? unitRange([]);
    const margin = 10;
    const usable = Math.max(40, this.height - margin * 2);
    this.lineGap = Math.max(5, Math.min(22, usable / Math.max(max - min, 1)));
    // Place the treble bottom line so the leftover space above and below is equal
    this.trebleBottomY = this.height / 2 - ((min + max) / 2) * this.lineGap;
    this.bassBottomY = this.trebleBottomY + this.lineGap * 10;
  }

  #yOf(placed) {
    const bottom = placed.treble ? this.trebleBottomY : this.bassBottomY;
    return bottom - (placed.offset * this.lineGap) / 2;
  }

  #render = () => {
    this.frame = requestAnimationFrame(this.#render);
    this.#draw();
  };

  #draw() {
    const { ctx, width, height } = this;
    const now = this.getTime?.() ?? 0;
    const pxPerSecond = width / WINDOW;
    const nowX = width * NOW_RATIO;
    const timeToX = (t) => nowX + (t - now) * pxPerSecond;

    ctx.clearRect(0, 0, width, height);
    this.#drawBarlines(timeToX);
    this.#drawStaves();

    if (this.placed.length) {
      const from = now - NOW_RATIO * WINDOW;
      const to = from + WINDOW;
      for (const placed of this.placed) {
        if (placed.end < from || placed.start > to) continue;
        this.#drawNote(placed, timeToX, now, pxPerSecond);
      }
    }

    // Vertical line marking "now"
    ctx.fillStyle = "rgba(98, 176, 255, 0.55)";
    ctx.fillRect(nowX, 0, 1.5, height);
  }

  #drawStaves() {
    const { ctx, width } = this;
    ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
    for (const bottom of [this.trebleBottomY, this.bassBottomY]) {
      for (let line = 0; line < 5; line++) ctx.fillRect(0, bottom - line * this.lineGap, width, 1);
    }
    // Clefs. Shown as G / F so they read even without a music font
    ctx.fillStyle = "rgba(200, 212, 228, 0.75)";
    ctx.font = `italic 600 ${this.lineGap * 2.4}px "Segoe UI", serif`;
    ctx.textBaseline = "middle";
    ctx.fillText("G", 4, this.trebleBottomY - this.lineGap * 1.5);
    ctx.fillText("F", 4, this.bassBottomY - this.lineGap * 2.6);
  }

  #drawBarlines(timeToX) {
    const measures = this.song?.measures;
    if (!measures?.length) return;
    const { ctx } = this;
    const top = this.trebleBottomY - this.lineGap * 4;
    const height = this.bassBottomY - top;
    ctx.fillStyle = "rgba(255, 255, 255, 0.13)";
    for (const measure of measures) {
      const x = timeToX(measure.time);
      if (x < -2 || x > this.width + 2) continue;
      ctx.fillRect(x, top, 1, height);
    }
  }

  #drawNote(placed, timeToX, now, pxPerSecond) {
    const { ctx } = this;
    const x = timeToX(placed.start);
    const y = this.#yOf(placed);
    const headW = this.lineGap * 1.25;
    const headH = this.lineGap * 0.92;
    const barW = Math.max((placed.end - placed.start) * pxPerSecond, headW * 0.6);
    const sounding = placed.start <= now && now < placed.end;
    const hue = HUES[placed.channel % HUES.length];

    this.#drawLedgerLines(placed, x, headW);

    // Bar showing the duration (extends behind the notehead)
    ctx.fillStyle = `hsl(${hue} 58% ${sounding ? 52 : 38}% / ${sounding ? 0.95 : 0.7})`;
    ctx.beginPath();
    ctx.roundRect(x, y - headH * 0.34, barW, headH * 0.68, headH * 0.34);
    ctx.fill();

    // Notehead: a slightly tilted ellipse, like in printed notation
    ctx.fillStyle = `hsl(${hue} 64% ${sounding ? 68 : 52}%)`;
    ctx.beginPath();
    ctx.ellipse(x + headW / 2, y, headW / 2, headH / 2, -0.35, 0, Math.PI * 2);
    ctx.fill();

    if (placed.accidental) {
      ctx.fillStyle = `hsl(${hue} 40% ${sounding ? 82 : 66}%)`;
      ctx.font = `${this.lineGap * 1.9}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.fillText(placed.accidental, x - 2, y);
      ctx.textAlign = "left";
    }
  }

  // Draw ledger lines for notes outside the staff. Without them the pitch can't be read.
  #drawLedgerLines(placed, x, headW) {
    const { ctx } = this;
    const bottom = placed.treble ? this.trebleBottomY : this.bassBottomY;
    const width = headW * 1.5;
    const left = x + headW / 2 - width / 2;
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";

    // offset is in staff steps from the bottom line. Below 0 sticks out below, above 8 sticks out above.
    for (let step = -2; step >= placed.offset; step -= 2) {
      ctx.fillRect(left, bottom - (step * this.lineGap) / 2, width, 1);
    }
    for (let step = 10; step <= placed.offset; step += 2) {
      ctx.fillRect(left, bottom - (step * this.lineGap) / 2, width, 1);
    }
  }
}
