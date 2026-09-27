import { SOURCE_RATE } from "./sfz.js";

const num = (v, fallback = 0) => (v === undefined ? fallback : Number(v));
const dbToGain = (db) => 10 ** (db / 20);

// CC7 (volume) and CC10 (pan) are handled channel-wide, so they are
// excluded from per-region amplitude_oncc (to avoid applying them twice).
const CHANNEL_CC = new Set([7, 10]);

// Polyphony limit. Running up all 88 keys with the pedal down reached 164 voices, so this
// stays below that while never interfering with normal playing (around 20).
const MAX_VOICES = 96;
const STEAL_FADE = 0.1; // Fade time in seconds for voice stealing. Cutting abruptly causes clicks

export class SfzSampler {
  /**
   * @param {AudioContext} ctx
   * @param {object} sfz Return value of loadSfz()
   * @param {string} baseUrl Base URL for resolving sample paths
   * @param {AudioNode} destination Usually FxChain.input
   */
  constructor(ctx, sfz, baseUrl, destination) {
    this.ctx = ctx;
    this.sfz = sfz;
    this.baseUrl = baseUrl;
    this.destination = destination;
    this.buffers = new Map();
    this.voices = new Set();
    this.veltrack = 1; // 0 = velocity doesn't affect volume, 1 = full
    this.resonance = true;
    this.pitchBend = 0; // cent

    this.cc = new Uint8Array(128);
    this.cc[7] = 100;
    this.cc[10] = 64;
    for (const [key, value] of Object.entries(sfz.control)) {
      const plain = key.match(/^set_cc(\d+)$/);
      if (plain) this.cc[Number(plain[1])] = Number(value);
      const hd = key.match(/^set_hdcc(\d+)$/); // High-resolution value in 0..1
      if (hd) this.cc[Number(hd[1])] = Math.round(Number(value) * 127);
    }
  }

  // ---- Sample loading -------------------------------------------------------

  /** Preloads all samples. Loads notes nearest middle C first so playing can start sooner. */
  async load(onProgress) {
    const nearest = new Map();
    for (const region of this.sfz.regions) {
      const distance = Math.abs((region.lokey + region.hikey) / 2 - 60);
      nearest.set(region.sample, Math.min(nearest.get(region.sample) ?? Infinity, distance));
    }
    const paths = [...nearest.keys()].sort((a, b) => nearest.get(a) - nearest.get(b));

    let done = 0;
    let bytes = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < paths.length) {
        const path = paths[cursor++];
        const buffer = await this.#decode(path);
        this.buffers.set(path, buffer);
        bytes += buffer.length * buffer.numberOfChannels * 4;
        onProgress?.({ done: ++done, total: paths.length, bytes });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  async #decode(path) {
    const url = this.baseUrl + path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`サンプルを読めません: ${path} (${response.status})`);
    const raw = await response.arrayBuffer();
    try {
      return await this.ctx.decodeAudioData(raw);
    } catch (cause) {
      throw new Error(
        `${path} をデコードできません。このブラウザは FLAC の decodeAudioData に対応していない可能性があります。`,
        { cause },
      );
    }
  }

  // ---- Envelope -------------------------------------------------------------

  // In ARIA, cc133 = note number. Higher notes get shorter hold / decay = a piano's decay characteristic.
  #envelope(note) {
    const g = this.sfz.global;
    const k = note / 127;
    return {
      hold: Math.max(0, num(g.ampeg_hold) + num(g.ampeg_hold_oncc133) * k),
      decay: Math.max(0.05, num(g.ampeg_decay, 1) + num(g.ampeg_decay_oncc133) * k),
      sustain: num(g.ampeg_sustain) / 100,
    };
  }

  // release = fixed region value + CC72 (Release knob) + CC64 (pedal position, via curve11)
  // The deeper the pedal, the longer the release; partway down gives half-pedaling.
  #releaseTime(region) {
    const g = this.sfz.global;
    const curve = this.sfz.curves.get(num(g.ampeg_release_curvecc64, -1));
    const pedal = curve ? curve[this.cc[64]] : this.cc[64] / 127;
    return Math.max(
      0.02,
      (region.release ?? 0) +
        num(g.ampeg_release_oncc72) * (this.cc[72] / 127) +
        num(g.ampeg_releasecc64) * pedal,
    );
  }

  // ---- Note playback --------------------------------------------------------

  #matches(region, note, velocity) {
    if (note < region.lokey || note > region.hikey) return false;
    if (velocity < region.lovel || velocity > region.hivel) return false;
    if (region.group === 1 && !this.resonance) return false;
    return region.ccConditions.every((c) => this.cc[c.cc] >= c.lo && this.cc[c.cc] <= c.hi);
  }

  /**
   * @param {number} when Note start time (in ctx.currentTime terms). Used for look-ahead
   *   scheduling during MIDI file playback. If omitted, the note plays immediately.
   */
  noteOn(note, velocity, when) {
    if (velocity === 0) return this.noteOff(note, when);
    for (const region of this.sfz.regions) {
      if (!this.#matches(region, note, velocity)) continue;
      const buffer = this.buffers.get(region.sample);
      if (buffer) this.#start(region, note, velocity, buffer, when);
    }
  }

  #start(region, note, velocity, buffer, when) {
    const { ctx } = this;
    const now = Math.max(when ?? 0, ctx.currentTime);
    const g = this.sfz.global;

    // note_polyphony=1: fade out the previous note on the same key and group over off_time
    if (num(g.note_polyphony, 0) === 1) {
      for (const voice of this.voices) {
        if (voice.note === note && voice.group === region.group) {
          this.#fadeOut(voice, num(g.off_time, 0.1), now);
        }
      }
    }

    if (this.#liveVoices() >= MAX_VOICES) this.#steal(now);

    // Volume: region volume/group_volume × velocity × amplitude_oncc × CC7
    let gain = dbToGain(region.volumeDb);
    gain *= 1 - this.veltrack * (1 - (velocity / 127) ** 2);
    for (const mod of region.amplitudeCC) {
      if (!CHANNEL_CC.has(mod.cc)) gain *= mod.depth * (this.cc[mod.cc] / 127);
    }
    gain *= (this.cc[7] / 127) ** 2;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 2 ** ((note - region.keycenter + region.tune / 100) / 12);
    source.detune.value = this.pitchBend;

    const envelope = ctx.createGain();
    const panner = ctx.createStereoPanner();
    // Region pan + CC10 channel pan
    panner.pan.value = Math.max(-1, Math.min(1, region.pan / 100 + (this.cc[10] - 64) / 63));

    let head = source;
    if (region.cutoff) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = region.cutoff;
      head.connect(filter);
      head = filter;
    }
    head.connect(envelope).connect(panner).connect(this.destination);

    const { hold, decay, sustain } = this.#envelope(note);
    const attackEnd = now + region.attack;
    const holdEnd = attackEnd + hold;
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(gain, attackEnd);
    envelope.gain.setValueAtTime(gain, holdEnd);
    // Exponential curve roughly equivalent to ampeg_release_shape=-6. A time constant of decay / 4 sounds right.
    envelope.gain.setTargetAtTime(gain * sustain, holdEnd, decay / 4);

    // offset is "a sample count in the original sample (44.1kHz)". After decodeAudioData the audio
    // is resampled to the ctx rate, so convert it to seconds before passing it.
    source.start(now, region.offset / SOURCE_RATE);

    // Remember the shape of the scheduled envelope so its value at a future time can be computed exactly later
    // (gain.value only returns the "current" value, so it's useless for look-ahead scheduling).
    const voice = {
      source,
      envelope,
      note,
      group: region.group,
      region,
      released: false,
      stealing: false,
      startedAt: now, // Used to order candidates for voice stealing (env.t0 is overwritten after a fade)
      env: { t0: now, attackEnd, holdEnd, peak: gain, sustain: gain * sustain, tc: decay / 4 },
    };
    source.onended = () => {
      this.voices.delete(voice);
      panner.disconnect();
    };
    this.voices.add(voice);
  }

  // Stolen voices are just waiting to fade out, so they don't count toward the limit
  #liveVoices() {
    let count = 0;
    for (const voice of this.voices) if (!voice.stealing) count++;
    return count;
  }

  /**
   * Frees up one voice when the limit is reached.
   * Prefers released voices; among those, steals the quietest, and on a tie the oldest.
   */
  #steal(when) {
    let victim = null;
    let lowest = Infinity;
    for (const voice of this.voices) {
      if (voice.stealing) continue;
      // Always rank released voices lower (level is roughly 0..1, so -1 is enough)
      const score = this.#levelAt(voice, when) - (voice.released ? 1 : 0);
      if (score < lowest || (score === lowest && voice.startedAt < victim.startedAt)) {
        victim = voice;
        lowest = score;
      }
    }
    if (!victim) return;
    victim.stealing = true;
    this.#fadeOut(victim, STEAL_FADE, when);
  }

  /**
   * Value of the scheduled envelope at the given time.
   * Using gain.value would apply the "current" value to a future time, and with fast
   * ornaments a voice that should have faded would come back at full volume (a volume jump).
   */
  #levelAt(voice, time) {
    const e = voice.env;
    if (time <= e.t0) return 0;
    if (time < e.attackEnd) return (e.peak * (time - e.t0)) / (e.attackEnd - e.t0);
    if (time <= e.holdEnd) return e.peak;
    return e.sustain + (e.peak - e.sustain) * Math.exp(-(time - e.holdEnd) / e.tc);
  }

  #fadeOut(voice, seconds, when) {
    const at = Math.max(when ?? 0, this.ctx.currentTime);
    const level = this.#levelAt(voice, at);
    const tc = Math.max(seconds, 0.01) / 4;

    voice.envelope.gain.cancelScheduledValues(at);
    voice.envelope.gain.setValueAtTime(level, at);
    voice.envelope.gain.setTargetAtTime(0, at, tc);

    // From here on the envelope is "an exponential from level at `at` toward 0".
    // Replace it so values stay continuous even if pedaling or repeated notes fade it twice.
    voice.env = { t0: -Infinity, attackEnd: -Infinity, holdEnd: at, peak: level, sustain: 0, tc };
    voice.released = true;
    voice.stopAt = at + seconds;
    voice.source.stop(voice.stopAt);
  }

  noteOff(note, when) {
    for (const voice of this.voices) {
      if (voice.note === note && !voice.released) {
        this.#fadeOut(voice, this.#releaseTime(voice.region), when);
      }
    }
  }

  controlChange(cc, value) {
    this.cc[cc] = value;
    // ampeg_dynamic=1: when the pedal moves, recompute the release of decaying notes.
    // Pressing extends them, lifting stops them (half-pedaling works too).
    if (cc === 64 && num(this.sfz.global.ampeg_dynamic, 0) === 1) {
      const now = this.ctx.currentTime;
      for (const voice of this.voices) {
        if (!voice.released || !voice.stopAt || voice.stopAt <= now) continue;
        this.#fadeOut(voice, this.#releaseTime(voice.region));
      }
    }
  }

  /** @param {number} cents Pitch bend amount. Applied immediately to sounding notes too. */
  setPitchBend(cents) {
    this.pitchBend = cents;
    const now = this.ctx.currentTime;
    for (const voice of this.voices) voice.source.detune.setTargetAtTime(cents, now, 0.01);
  }

  allNotesOff() {
    for (const voice of this.voices) this.#fadeOut(voice, 0.15);
  }

  /** Number of voices counted toward the limit. Excludes voices fading out after being stolen. */
  get activeVoices() {
    return this.#liveVoices();
  }

  get maxVoices() {
    return MAX_VOICES;
  }
}
