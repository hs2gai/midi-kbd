// SFZ v2 (plus some ARIA extensions) parser.
// Covers only the features Splendid Grand Piano actually uses:
//   #define / #include / <control> <global> <group> <region> <curve>
//   default_path, lokey, hikey, lovel, hivel, pitch_keycenter, sample,
//   offset, tune, pan, volume, group_volume, cutoff, ampeg_*, locc/hicc, amplitude_oncc
export const SOURCE_RATE = 44100; // Original sample rate. Needed for conversion, since offset is in original-rate samples

const num = (v, fallback = 0) => (v === undefined ? fallback : Number(v));
const BACKSLASH = String.fromCharCode(92); // Used to normalize Windows-style sample path separators to /

function dirOf(url) {
  return url.slice(0, url.lastIndexOf("/") + 1);
}

// $NAME is replaced as a whole token, so prefix collisions like $RES / $RELEASE cannot happen
function substitute(text, defines) {
  return text.includes("$") ? text.replace(/\$\w+/g, (m) => defines.get(m) ?? m) : text;
}

// Expands #define and #include in order, pushing only body lines onto out.
// defines is updated as we go (the same $DYN is redefined for each <group>).
// parents is the include chain. Reading the same file from different places is legitimate, so only cycles are rejected.
async function ingest(url, defines, out, parents = []) {
  if (parents.includes(url)) throw new Error(`SFZ の #include が循環しています: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SFZ を読めません: ${url} (${res.status})`);
  const dir = dirOf(url);

  for (const raw of (await res.text()).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    const def = line.match(/^#define\s+(\$\w+)\s+(\S+)/);
    if (def) {
      defines.set(def[1], def[2]);
      continue;
    }
    const inc = line.match(/^#include\s+"([^"]+)"/);
    if (inc) {
      await ingest(dir + substitute(inc[1], defines), defines, out, [...parents, url]);
      continue;
    }
    out.push(substitute(line, defines));
  }
}

// Extracts `<header>` and `opcode=value` in order of appearance.
// A value runs up to the next token, so values with spaces like `sample=FF B-1.flac` are captured too.
function tokenize(text) {
  const re = /<(\w+)>|([a-zA-Z0-9_]+)=/g;
  const marks = [];
  for (let m; (m = re.exec(text)); ) {
    marks.push({ header: m[1], opcode: m[2], start: m.index, end: re.lastIndex });
  }
  return marks.map((mark, i) =>
    mark.header
      ? { header: mark.header }
      : {
          opcode: mark.opcode,
          value: text.slice(mark.end, i + 1 < marks.length ? marks[i + 1].start : text.length).trim(),
        },
  );
}

// Extracts CC conditions such as locc64=65
function ccConditions(raw) {
  const conds = [];
  for (const [key, value] of Object.entries(raw)) {
    const lo = key.match(/^locc(\d+)$/);
    if (lo) conds.push({ cc: Number(lo[1]), lo: Number(value), hi: 127 });
    const hi = key.match(/^hicc(\d+)$/);
    if (hi) conds.push({ cc: Number(hi[1]), lo: 0, hi: Number(value) });
  }
  return conds;
}

function finalize(raw, control) {
  const amplitudeCC = Object.entries(raw)
    .map(([key, value]) => [key.match(/^amplitude_oncc(\d+)$/), value])
    .filter(([m]) => m)
    .map(([m, value]) => ({ cc: Number(m[1]), depth: Number(value) / 100 }));

  return {
    sample: (control.default_path ?? "") + raw.sample.replaceAll(BACKSLASH, "/"),
    lokey: num(raw.lokey, 0),
    hikey: num(raw.hikey, 127),
    lovel: num(raw.lovel, 0),
    hivel: num(raw.hivel, 127),
    keycenter: num(raw.pitch_keycenter, 60),
    tune: num(raw.tune, 0), // cent
    pan: num(raw.pan, 0), // -100..100
    volumeDb: num(raw.volume, 0) + num(raw.group_volume, 0),
    offset: num(raw.offset, 0), // in original-rate samples
    cutoff: raw.cutoff ? Number(raw.cutoff) : null,
    group: num(raw.group, 0),
    attack: num(raw.ampeg_attack, 0.0005),
    // null if not set per region; the CC-linked release from global is used instead
    release: raw.ampeg_release === undefined ? null : Number(raw.ampeg_release),
    ccConditions: ccConditions(raw),
    amplitudeCC,
  };
}

/**
 * Loads an SFZ and returns { control, global, curves, regions }.
 * regions already have the <global> / <group> opcodes merged in.
 */
export async function loadSfz(url) {
  const lines = [];
  await ingest(url, new Map(), lines);

  const control = {};
  const globalOpcodes = {};
  const curves = new Map();
  const rawRegions = [];
  let group = {};
  let target = globalOpcodes;

  for (const token of tokenize(lines.join("\n"))) {
    if (!token.header) {
      target[token.opcode] = token.value;
      continue;
    }
    switch (token.header) {
      case "control":
        target = control;
        break;
      case "global":
        target = globalOpcodes;
        break;
      case "group":
        group = {};
        target = group;
        break;
      case "region": {
        const region = { ...globalOpcodes, ...group };
        rawRegions.push(region);
        target = region;
        break;
      }
      case "curve":
        target = {};
        curves.set(target, target); // curve_index is read later
        break;
      default:
        target = {}; // discard unknown headers
    }
  }

  // Convert <curve> into index -> 128-point table
  const curveTable = new Map();
  for (const curve of curves.keys()) {
    if (curve.curve_index === undefined) continue;
    const points = Object.entries(curve)
      .map(([key, value]) => [key.match(/^v(\d+)$/), value])
      .filter(([m]) => m)
      .map(([m, value]) => [Number(m[1]), Number(value)])
      .sort((a, b) => a[0] - b[0]);
    curveTable.set(Number(curve.curve_index), buildCurve(points));
  }

  return {
    control,
    global: globalOpcodes,
    curves: curveTable,
    regions: rawRegions.filter((r) => r.sample).map((r) => finalize(r, control)),
  };
}

// Fills all points 0..127 by linear interpolation of sparse (index, value) points
function buildCurve(points) {
  const table = new Float32Array(128);
  if (points.length === 0) return table;
  for (let i = 0; i < 128; i++) {
    let lo = points[0];
    let hi = points[points.length - 1];
    for (const p of points) {
      if (p[0] <= i) lo = p;
      if (p[0] >= i) {
        hi = p;
        break;
      }
    }
    table[i] = hi[0] === lo[0] ? lo[1] : lo[1] + ((hi[1] - lo[1]) * (i - lo[0])) / (hi[0] - lo[0]);
  }
  return table;
}
