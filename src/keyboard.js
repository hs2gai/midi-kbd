// On-screen 88-key keyboard. Used to visualize MIDI input and to play with mouse/touch.

const LOWEST = 21; // A0
const HIGHEST = 108; // C8
const BLACK = new Set([1, 3, 6, 8, 10]);

const isBlack = (note) => BLACK.has(note % 12);

export class Keyboard {
  /**
   * @param {HTMLElement} host
   * @param {object} handlers onNoteOn(note, velocity) / onNoteOff(note)
   */
  constructor(host, handlers) {
    this.host = host;
    this.handlers = handlers;
    this.keys = new Map();
    // Used by the note-fall view to align horizontally with the keys (values are in %)
    this.layout = new Map();
    this.pointerNote = null;

    const whiteNotes = [];
    for (let note = LOWEST; note <= HIGHEST; note++) if (!isBlack(note)) whiteNotes.push(note);
    const whiteWidth = 100 / whiteNotes.length;

    let whiteIndex = 0;
    for (let note = LOWEST; note <= HIGHEST; note++) {
      const key = document.createElement("div");
      const black = isBlack(note);
      key.dataset.note = String(note);
      // Hang each black key off the right edge of the preceding white key
      const left = black ? whiteIndex * whiteWidth - whiteWidth * 0.3 : whiteIndex * whiteWidth;
      const width = black ? whiteWidth * 0.6 : whiteWidth;

      key.className = black ? "key black" : "key white";
      key.style.left = `${left}%`;
      key.style.width = `${width}%`;
      if (!black) {
        if (note % 12 === 0) key.dataset.label = `C${note / 12 - 1}`;
        whiteIndex++;
      }

      this.layout.set(note, { left, width, black });
      this.keys.set(note, key);
      this.host.append(key);
    }

    this.host.addEventListener("pointerdown", this.#onPointerDown);
    this.host.addEventListener("pointermove", this.#onPointerMove);
    window.addEventListener("pointerup", this.#onPointerUp);
    window.addEventListener("pointercancel", this.#onPointerUp);
  }

  #noteAt(event) {
    const note = Number(event.target?.dataset?.note);
    return Number.isFinite(note) && note ? note : null;
  }

  // Map the vertical position on the key to velocity (stronger toward the bottom), so dynamics can be tried without hardware.
  #velocityAt(event) {
    const box = event.target.getBoundingClientRect();
    const ratio = (event.clientY - box.top) / box.height;
    return Math.max(20, Math.min(127, Math.round(35 + ratio * 92)));
  }

  #onPointerDown = (event) => {
    const note = this.#noteAt(event);
    if (!note) return;
    event.preventDefault();
    this.host.setPointerCapture?.(event.pointerId);
    this.pointerNote = note;
    this.handlers.onNoteOn?.(note, this.#velocityAt(event));
  };

  #onPointerMove = (event) => {
    if (this.pointerNote === null) return;
    // During pointer capture event.target stays fixed, so look up the key from the coordinates
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const note = Number(element?.dataset?.note);
    if (!note || note === this.pointerNote) return;
    this.handlers.onNoteOff?.(this.pointerNote);
    this.pointerNote = note;
    this.handlers.onNoteOn?.(note, 80);
  };

  #onPointerUp = () => {
    if (this.pointerNote === null) return;
    this.handlers.onNoteOff?.(this.pointerNote);
    this.pointerNote = null;
  };

  setActive(note, active) {
    this.keys.get(note)?.classList.toggle("active", active);
  }

  clear() {
    for (const key of this.keys.values()) key.classList.remove("active");
  }
}
