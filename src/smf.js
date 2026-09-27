// Standard MIDI File (SMF format 0 / 1 / 2) parser.
// Merges all tracks into a single timeline and applies the tempo map to convert times to seconds.

const META = 0xff;
const SYSEX = 0xf0;
const SYSEX_ESCAPE = 0xf7;
const META_TEMPO = 0x51;
const META_TRACK_NAME = 0x03;
const META_END_OF_TRACK = 0x2f;
const META_TIME_SIGNATURE = 0x58;

const DEFAULT_TEMPO = 500000; // µs per quarter note = 120 BPM

class Reader {
  constructor(view, start = 0, end = view.byteLength) {
    this.view = view;
    this.pos = start;
    this.end = end;
  }
  get done() {
    return this.pos >= this.end;
  }
  u8() {
    return this.view.getUint8(this.pos++);
  }
  u16() {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  ascii(length) {
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.u8());
    return out;
  }
  skip(length) {
    this.pos += length;
  }
  /** Variable-length quantity: concatenates the low 7 bits of each byte; a byte with MSB 0 ends it. */
  varlen() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }
}

// Reads one track into a list of events with absolute ticks
function parseTrack(view, start, length) {
  const r = new Reader(view, start, start + length);
  const events = [];
  let tick = 0;
  let runningStatus = 0;

  while (!r.done) {
    tick += r.varlen();

    let status = r.u8();
    if (status < 0x80) {
      // Running status: the status byte is omitted
      r.pos--;
      status = runningStatus;
    } else if (status < META) {
      runningStatus = status;
    }

    if (status === META) {
      const type = r.u8();
      const length = r.varlen();
      const at = r.pos;
      if (type === META_TEMPO) {
        events.push({ tick, type: "tempo", value: (r.view.getUint8(at) << 16) | r.view.getUint16(at + 1) });
      } else if (type === META_TIME_SIGNATURE) {
        events.push({
          tick,
          type: "timeSignature",
          numerator: r.view.getUint8(at),
          denominator: 2 ** r.view.getUint8(at + 1),
        });
      } else if (type === META_TRACK_NAME) {
        events.push({ tick, type: "trackName", value: new Reader(view, at, at + length).ascii(length) });
      } else if (type === META_END_OF_TRACK) {
        r.skip(length);
        break;
      }
      r.pos = at + length;
      continue;
    }

    if (status === SYSEX || status === SYSEX_ESCAPE) {
      r.skip(r.varlen());
      continue;
    }

    const channel = status & 0x0f;
    switch (status & 0xf0) {
      case 0x80:
        events.push({ tick, type: "noteOff", channel, note: r.u8(), velocity: r.u8() });
        break;
      case 0x90: {
        const note = r.u8();
        const velocity = r.u8();
        // A Note On with velocity 0 is equivalent to Note Off
        events.push({ tick, type: velocity > 0 ? "noteOn" : "noteOff", channel, note, velocity });
        break;
      }
      case 0xa0:
        r.skip(2); // Polyphonic aftertouch: not used by this instrument
        break;
      case 0xb0:
        events.push({ tick, type: "cc", channel, cc: r.u8(), value: r.u8() });
        break;
      case 0xc0:
        r.skip(1); // Program change: ignored since there is only one instrument
        break;
      case 0xd0:
        r.skip(1); // Channel aftertouch
        break;
      case 0xe0: {
        const lsb = r.u8();
        const msb = r.u8();
        events.push({ tick, type: "pitchBend", channel, value: ((msb << 7) | lsb) - 8192 });
        break;
      }
      default:
        // Unknown status. We can no longer stay in sync, so stop reading this track
        return events;
    }
  }
  return events;
}

/**
 * Parses an SMF.
 * @param {ArrayBuffer} buffer
 * @param {string} fallbackName display name used when there is no track name
 * @returns {{name: string, duration: number, events: Array}} times are in seconds
 */
export function parseMidi(buffer, fallbackName = "MIDI") {
  const view = new DataView(buffer);
  if (view.byteLength < 14 || new Reader(view).ascii(4) !== "MThd") {
    throw new Error("MIDI ファイルとして読めません（MThd ヘッダが見つかりません）。");
  }

  const header = new Reader(view);
  header.skip(4);
  const headerLength = header.u32();
  header.u16(); // format: unused, since 0/1/2 are all handled by merging tracks
  const trackCount = header.u16();
  const division = header.u16();

  // Collect track chunks in order (skip chunks other than MTrk)
  const tracks = [];
  let pos = 8 + headerLength;
  while (pos + 8 <= view.byteLength && tracks.length < trackCount) {
    const id = new Reader(view, pos).ascii(4);
    const length = view.getUint32(pos + 4);
    if (id === "MTrk") tracks.push(parseTrack(view, pos + 8, length));
    pos += 8 + length;
  }
  if (tracks.length === 0) throw new Error("MIDI ファイルにトラックが入っていません。");

  // At the same tick, keep track order and original order (sort is stable, so index is enough)
  const merged = tracks
    .flatMap((events, track) => events.map((event, index) => ({ ...event, track, order: track * 1e6 + index })))
    .sort((a, b) => a.tick - b.tick || a.order - b.order);

  return toSeconds(merged, division, fallbackName);
}

/** Converts tick-based events to seconds using the tempo map. */
function toSeconds(events, division, fallbackName) {
  // If the top bit is set, the division is SMPTE (absolute time, independent of tempo)
  const smpte = (division & 0x8000) !== 0;
  const ticksPerSecond = smpte ? (256 - (division >> 8)) * (division & 0xff) : 0;
  const ticksPerQuarter = smpte ? 0 : division;
  if (!smpte && ticksPerQuarter === 0) throw new Error("MIDI ファイルの分解能が不正です。");

  let name = fallbackName;
  let tempo = DEFAULT_TEMPO;
  let lastTick = 0;
  let seconds = 0;
  const out = [];
  const tempoPoints = [{ tick: 0, seconds: 0, tempo: DEFAULT_TEMPO }];
  const timeSignatures = [];

  for (const event of events) {
    seconds += smpte
      ? (event.tick - lastTick) / ticksPerSecond
      : ((event.tick - lastTick) * tempo) / ticksPerQuarter / 1e6;
    lastTick = event.tick;

    if (event.type === "tempo") {
      tempo = event.value;
      tempoPoints.push({ tick: event.tick, seconds, tempo });
      continue;
    }
    if (event.type === "timeSignature") {
      timeSignatures.push({ tick: event.tick, numerator: event.numerator, denominator: event.denominator });
      continue;
    }
    if (event.type === "trackName") {
      if (name === fallbackName && event.value.trim()) name = event.value.trim();
      continue;
    }
    out.push({ ...event, time: seconds });
  }

  // The end of the song is determined by the last performance event (note, CC, etc.). Some files
  // have only meta events such as tempo or end of track trailing behind (about 73 s in BWV 846),
  // and counting up to them leaves a long silence. Add a short tail so the last note can ring out.
  const last = out.at(-1);
  const endTick = last?.tick ?? 0;
  const duration = (last?.time ?? 0) + 2;
  return {
    name,
    events: out,
    duration,
    notes: pairNotes(out, duration, endTick),
    timeSignature: timeSignatures[0] ?? { numerator: 4, denominator: 4 },
    // The score view builds measures from ticks, so pass the division too (0 for SMPTE)
    ticksPerQuarter,
    measures: smpte ? [] : barlines(timeSignatures, tempoPoints, ticksPerQuarter, endTick),
  };
}

/** Converts a tick to seconds. Accumulates correctly across tempo changes. */
function tickToSeconds(tick, tempoPoints, ticksPerQuarter) {
  let point = tempoPoints[0];
  for (const candidate of tempoPoints) {
    if (candidate.tick > tick) break;
    point = candidate;
  }
  return point.seconds + ((tick - point.tick) * point.tempo) / ticksPerQuarter / 1e6;
}

/** Lists barline times (seconds). Follows time signature changes mid-song. */
function barlines(timeSignatures, tempoPoints, ticksPerQuarter, lastTick) {
  // The same time signature may be written in each track, so collapse to one per tick
  const byTick = new Map();
  for (const signature of timeSignatures) byTick.set(signature.tick, signature);
  const signatures = [...byTick.values()].sort((a, b) => a.tick - b.tick);
  if (!signatures.length || signatures[0].tick > 0) {
    signatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }

  const bars = [];
  for (const [index, signature] of signatures.entries()) {
    const perMeasure = (ticksPerQuarter * 4 * signature.numerator) / signature.denominator;
    const until = signatures[index + 1]?.tick ?? lastTick;
    if (perMeasure <= 0) continue;
    // Cap at a sensible limit so songs with very short measures don't overwhelm rendering
    for (let tick = signature.tick; tick <= until && bars.length < 5000; tick += perMeasure) {
      bars.push({
        tick,
        time: tickToSeconds(tick, tempoPoints, ticksPerQuarter),
        numerator: signature.numerator,
        denominator: signature.denominator,
        ticks: perMeasure,
      });
    }
  }
  return bars;
}

/**
 * Matches Note On / Note Off into a list of {note, start, end, velocity}.
 * Used for the piano roll display.
 */
function pairNotes(events, duration, lastTick) {
  const open = new Map(); // channel*128+note -> start info
  const notes = [];
  const close = (key, time, tick) => {
    const started = open.get(key);
    if (!started) return;
    open.delete(key);
    notes.push({
      ...started,
      end: Math.max(time, started.start + 0.02),
      endTick: Math.max(tick, started.startTick + 1),
    });
  };

  for (const event of events) {
    if (event.type !== "noteOn" && event.type !== "noteOff") continue;
    const key = event.channel * 128 + event.note;
    close(key, event.time, event.tick); // If the same note overlaps, close the previous one
    if (event.type === "noteOn") {
      open.set(key, {
        note: event.note,
        channel: event.channel,
        track: event.track, // Used to assign notes to the upper/lower staff (some MIDI files put both hands on one channel)
        velocity: event.velocity,
        start: event.time,
        startTick: event.tick,
      });
    }
  }
  // Close any unterminated notes at the end of the song
  for (const key of [...open.keys()]) close(key, duration, lastTick);

  return notes.sort((a, b) => a.start - b.start);
}
