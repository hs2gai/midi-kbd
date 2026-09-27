// Static server. Mounts the project root at / and each MOUNTS entry (SoundFont folder, VexFlow) at its prefix.
// The Web MIDI API requires a secure context, so open it via http://localhost.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { MOUNTS, PROJECT_ROOT } from "./paths.mjs";
import { listMidiPresets } from "./presets.mjs";

const PORT = Number(process.env.PORT ?? 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sfz": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".svg": "image/svg+xml",
};

// Decodes the path part of the URL. Malformed percent-encoding (e.g. /%) throws URIError, so return null (-> 400).
function decodePath(url) {
  try {
    return decodeURIComponent(url.split("?")[0]);
  } catch {
    return null;
  }
}

// Resolves the actual file from the mounts and the decoded path. Directory traversal is rejected.
function locate(decoded) {
  const mount = Object.keys(MOUNTS).find((prefix) => decoded.startsWith(prefix));
  const [base, rel] = mount
    ? [MOUNTS[mount], decoded.slice(mount.length)]
    : [PROJECT_ROOT, decoded === "/" ? "index.html" : decoded.slice(1)];
  const full = resolve(base, rel);
  const guard = resolve(base) + sep;
  return full.startsWith(guard) || full === resolve(base) ? full : null;
}

const URL_BASE = `http://localhost:${PORT}`;
const MARKER = "Web MIDI + SFZ"; // marker string contained in index.html

function openBrowser() {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", URL_BASE]]
      : [process.platform === "darwin" ? "open" : "xdg-open", [URL_BASE]];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

/** Whether the port is held by ourselves (an already running instance of this app). */
async function isAlreadyRunning() {
  try {
    const response = await fetch(URL_BASE, { signal: AbortSignal.timeout(2000) });
    return response.ok && (await response.text()).includes(MARKER);
  } catch {
    return false; // another app, or something that doesn't respond
  }
}

const server = createServer(async (req, res) => {
  if ((req.url ?? "").split("?")[0] === "/api/midi") {
    const body = JSON.stringify(await listMidiPresets(resolve(PROJECT_ROOT, "midi")));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" }).end(body);
    return;
  }

  const path = decodePath(req.url ?? "/");
  if (path === null) {
    res.writeHead(400).end("bad request");
    return;
  }
  const file = locate(path);
  if (!file) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`404 ${req.url}`);
  }
});

const shouldOpen = process.argv.includes("--open");

// Don't crash if the port is taken. If already running, just open the existing page.
server.on("error", async (error) => {
  if (error.code !== "EADDRINUSE") throw error;
  if (await isAlreadyRunning()) {
    console.log(`\n  すでに起動しています -> ${URL_BASE}`);
    console.log("  このウィンドウは閉じてかまいません。");
    console.log("  停止したいときは、先に起動しているウィンドウで Ctrl+C を押してください。\n");
    if (shouldOpen) openBrowser();
    return;
  }
  console.error(`\n  ポート ${PORT} は別のアプリが使用中です。`);
  console.error("  別のポートで起動するには、環境変数 PORT を指定してください:");
  console.error("      set PORT=5174 && node server.mjs --open\n");
  process.exitCode = 1;
});

// Listen on loopback only, so other devices on the LAN can't see the project (.git etc.)
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ${URL_BASE}\n`);
  console.log(`  /      -> ${PROJECT_ROOT}`);
  for (const [prefix, dir] of Object.entries(MOUNTS)) console.log(`  ${prefix} -> ${dir}`);
  console.log("");
  console.log("  終了するには Ctrl+C\n");
  if (shouldOpen) openBrowser();
});
