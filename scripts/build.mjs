// Assembles dist/ for Cloudflare Workers (static assets).
// From midi/, only redistributable folders (PUBLIC_MIDI) are bundled, and the preset list /api/midi is written out as static JSON.
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { MOUNTS, PROJECT_ROOT, SFZ_ROOT } from "../paths.mjs";
import { listMidiPresets } from "../presets.mjs";

const DIST = resolve(PROJECT_ROOT, "dist");
const INSTRUMENT = "SplendidGrandPiano"; // matches INSTRUMENT_DIR in src/main.js
// midi/bach (Bach Central) is local-only, since we couldn't confirm permission to redistribute it
const PUBLIC_MIDI = ["piano-midi.de"]; // CC BY-SA 3.0 DE. Credits are in each folder's credit.json
const MAX_ASSET_BYTES = 25 * 1024 * 1024; // per-file limit of Workers Static Assets

// [destination in dist, source]
const COPIES = [
  ["index.html", resolve(PROJECT_ROOT, "index.html")],
  ["src", resolve(PROJECT_ROOT, "src")],
  [".", resolve(PROJECT_ROOT, "public")], // _headers
  [`sfz/${INSTRUMENT}`, resolve(SFZ_ROOT, INSTRUMENT)],
  ["vendor/vexflow", MOUNTS["/vendor/vexflow/"]],
  ...PUBLIC_MIDI.map((folder) => [`midi/${folder}`, resolve(PROJECT_ROOT, "midi", folder)]),
];

// Don't serve hidden files such as .git, or VexFlow's test code
const include = (path) => !basename(path).startsWith(".") && basename(path) !== "tests";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

// On Windows, dist/ itself can't be deleted while wrangler dev is watching it, so only empty its contents
await mkdir(DIST, { recursive: true });
for (const name of await readdir(DIST)) await rm(resolve(DIST, name), { recursive: true, force: true });
for (const [dest, src] of COPIES) {
  await cp(src, resolve(DIST, dest), { recursive: true, filter: include });
}
await mkdir(resolve(DIST, "api"));
await writeFile(resolve(DIST, "api/midi"), JSON.stringify(await listMidiPresets(resolve(DIST, "midi"))));

const files = await walk(DIST);
const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
const oversized = files.filter((_, i) => sizes[i] > MAX_ASSET_BYTES);
if (oversized.length) throw new Error(`25 MiB を超えるファイルがあります:\n${oversized.join("\n")}`);

const totalMb = (sizes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(1);
console.log(`dist/ -> ${files.length} files, ${totalMb} MB`);
