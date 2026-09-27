// Piano-roll view during MIDI playback. Notes fall from the top and sound the moment they reach the keyboard.
// Horizontal positions reuse the Keyboard layout as is, so they always line up with the keys.

const LOOKAHEAD = 3.0; // How many seconds ahead are visible
const MIN_HEIGHT = 3; // Minimum height so short notes don't collapse (px)

// Hue per channel. Muted tones based on the existing UI accent (blue).
const HUES = [208, 168, 262, 32, 140, 318, 190, 92];

export class NoteFall {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import("./keyboard.js").Keyboard} keyboard Reference for horizontal positions
   */
  constructor(canvas, keyboard) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.keyboard = keyboard;
    this.notes = [];
    this.getTime = null;
    this.frame = 0;

    this.resize();
    new ResizeObserver(() => {
      this.resize();
      if (!this.frame) this.#draw(); // Keep the display even while stopped
    }).observe(canvas);
    this.#draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    // Cap the size so it can't blow up if broken CSS falls back to the intrinsic size
    const clamp = (v) => Math.min(Math.max(1, Math.round(v)), 8000);
    this.width = clamp(this.canvas.clientWidth);
    this.height = clamp(this.canvas.clientHeight);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** @param {Array|null} notes song.notes from smf.js. null stops the display. */
  setNotes(notes) {
    this.notes = notes ?? [];
  }

  /** @param {() => number} getTime Function returning the current playback position (seconds) */
  start(getTime) {
    this.getTime = getTime;
    if (!this.frame) this.frame = requestAnimationFrame(this.#render);
  }

  /**
   * Stop rAF and hold a still frame at the current position.
   * The drawing is kept so notes don't vanish on pause.
   */
  freeze(getTime) {
    if (getTime) this.getTime = getTime;
    this.#halt();
    this.#draw();
  }

  /** When the song is closed. Clears the notes, leaving only the guides. */
  clear() {
    this.#halt();
    this.notes = [];
    this.getTime = null;
    this.#draw();
  }

  #halt() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  #drawBaseline() {
    this.ctx.fillStyle = "rgba(98, 176, 255, 0.5)";
    this.ctx.fillRect(0, this.height - 1.5, this.width, 1.5);
  }

  #render = () => {
    this.frame = requestAnimationFrame(this.#render);
    this.#draw();
  };

  // With no notes, only the guides and baseline are drawn, so this doubles as the idle display
  #draw() {
    const now = this.getTime?.() ?? 0;
    const { ctx, width, height } = this;

    ctx.clearRect(0, 0, width, height);
    this.#drawGuides();

    for (const note of this.notes) {
      // Map remaining time to height so the note hits the bottom (keyboard) exactly at start
      const bottom = height * (1 - (note.start - now) / LOOKAHEAD);
      if (bottom < 0) continue; // Still above the screen
      const top = height * (1 - (note.end - now) / LOOKAHEAD);
      if (top > height) continue; // Already past the keyboard

      const key = this.keyboard.layout.get(note.note);
      if (!key) continue;

      const x = (key.left / 100) * width;
      const w = (key.width / 100) * width;
      const y = Math.max(top, -MIN_HEIGHT);
      const h = Math.max(bottom - y, MIN_HEIGHT);

      const hue = HUES[note.channel % HUES.length];
      const light = 34 + (note.velocity / 127) * 26;
      // Slightly brighter only while touching the keyboard
      const playing = note.start <= now && now < note.end;
      ctx.fillStyle = `hsl(${hue} ${key.black ? 52 : 62}% ${playing ? light + 14 : light}%)`;
      ctx.beginPath();
      ctx.roundRect(x + 1, y, Math.max(w - 2, 1), Math.min(h, height - y), 3);
      ctx.fill();
    }

    this.#drawBaseline(); // Line touching the keyboard = the "now" position
  }

  /** Draw faint vertical lines at octave boundaries (each C). */
  #drawGuides() {
    const { ctx, width, height } = this;
    ctx.fillStyle = "rgba(255, 255, 255, 0.045)";
    for (const [note, key] of this.keyboard.layout) {
      if (note % 12 !== 0) continue;
      ctx.fillRect((key.left / 100) * width, 0, 1, height);
    }
  }
}
