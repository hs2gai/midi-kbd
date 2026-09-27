// MIDI file playback.
//
// Uses look-ahead scheduling against the AudioContext clock. Triggering notes from setInterval
// alone turns timer jitter directly into timing wobble, so each note's start time is passed
// to the sampler and Web Audio plays it precisely.

const TICK = 10; // Scheduler interval (ms)
const LOOKAHEAD = 0.06; // How many seconds ahead to queue events

// Bringing in the file's volume and pan CCs would fight with the on-screen knobs,
// so only CCs that affect expressive performance are passed through.
const FORWARDED_CC = new Set([
  64, // Sustain pedal
  66, // Sostenuto
  67, // Soft pedal
]);

export class MidiPlayer {
  /**
   * @param {AudioContext} ctx
   * @param {import("./sampler.js").SfzSampler} sampler
   * @param {object} handlers onTick(position, duration) / onStateChange(state)
   */
  constructor(ctx, sampler, handlers = {}) {
    this.ctx = ctx;
    this.sampler = sampler;
    this.handlers = handlers;
    this.song = null;
    this.position = 0; // Seconds elapsed from the start of the song
    this.playing = false;
    this.index = 0;
    this.startTime = 0;
    this.timer = 0;
    this.skipDrums = true; // ch.10 falls apart when played on piano, so ignore it by default
  }

  load(song) {
    this.stop();
    this.song = song;
    this.#emitState();
  }

  get duration() {
    return this.song?.duration ?? 0;
  }

  get currentTime() {
    return this.playing ? Math.min(this.ctx.currentTime - this.startTime, this.duration) : this.position;
  }

  eject() {
    this.stop();
    this.song = null;
    this.#emitState();
  }

  play() {
    if (!this.song || this.playing) return;
    if (this.position >= this.duration) this.position = 0;
    this.playing = true;
    this.startTime = this.ctx.currentTime - this.position;
    this.#seekIndex();
    this.timer = setInterval(this.#schedule, TICK);
    this.#emitState();
  }

  pause() {
    if (!this.playing) return;
    this.position = this.ctx.currentTime - this.startTime;
    this.#halt();
    this.#emitState();
  }

  stop() {
    this.position = 0;
    this.#halt();
    this.#emitState();
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    this.#halt();
    this.position = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) this.play();
    else {
      this.#seekIndex();
      this.#emitState();
    }
  }

  #halt() {
    clearInterval(this.timer);
    this.timer = 0;
    this.playing = false;
    // Release the pedal first. In the reverse order, ampeg_dynamic recomputes the release
    // and the quick fade from allNotesOff gets overwritten by a long release.
    this.#setCc(64, 0);
    this.sampler.allNotesOff();
  }

  #setCc(cc, value) {
    this.sampler.controlChange(cc, value);
    this.handlers.onControlChange?.(cc, value);
  }

  /** Advances the cursor to the event index corresponding to this.position. */
  #seekIndex() {
    const events = this.song?.events ?? [];
    this.index = 0;
    while (this.index < events.length && events[this.index].time < this.position) this.index++;
  }

  #schedule = () => {
    const events = this.song.events;
    const position = this.ctx.currentTime - this.startTime;
    const horizon = position + LOOKAHEAD;

    while (this.index < events.length && events[this.index].time <= horizon) {
      const event = events[this.index++];
      this.#dispatch(event, this.startTime + event.time);
    }

    this.handlers.onTick?.(Math.min(position, this.duration), this.duration);

    if (position >= this.duration) {
      this.stop();
    }
  };

  #dispatch(event, when) {
    if (this.skipDrums && event.channel === 9) return;
    switch (event.type) {
      case "noteOn":
        this.sampler.noteOn(event.note, event.velocity, when);
        this.handlers.onNote?.(event.note, true);
        break;
      case "noteOff":
        this.sampler.noteOff(event.note, when);
        this.handlers.onNote?.(event.note, false);
        break;
      case "cc":
        // CCs are instrument state and can't be time-scheduled, so they take effect early by the look-ahead window (60ms).
        if (FORWARDED_CC.has(event.cc)) this.#setCc(event.cc, event.value);
        else if (event.cc === 120 || event.cc === 123) this.sampler.allNotesOff();
        break;
      case "pitchBend":
        this.sampler.setPitchBend((event.value / 8192) * 200);
        break;
    }
  }

  #emitState() {
    this.handlers.onStateChange?.({
      loaded: Boolean(this.song),
      name: this.song?.name ?? "",
      playing: this.playing,
      position: this.position,
      duration: this.duration,
    });
  }
}
