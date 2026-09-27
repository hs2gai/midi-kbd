// Recursively collects .mid files under midi/ into a preset list. Shared by server.mjs (/api/midi) and scripts/build.mjs.
// If a folder has a credit.json, it is attached as credit to the songs in it, including subfolders (for CC BY-style attribution).
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function readCredit(dir) {
  const text = await readFile(resolve(dir, "credit.json"), "utf8").catch(() => null);
  return text && JSON.parse(text);
}

export async function listMidiPresets(root) {
  const items = [];
  const walk = async (dir, folder, inherited) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const credit = (await readCredit(dir)) ?? inherited;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        await walk(resolve(dir, entry.name), folder ? `${folder}/${entry.name}` : entry.name, credit);
      } else if (/\.midi?$/i.test(entry.name)) {
        const parts = folder ? [...folder.split("/"), entry.name] : [entry.name];
        items.push({
          folder: folder || "midi",
          name: entry.name.replace(/\.midi?$/i, ""),
          url: `/midi/${parts.map(encodeURIComponent).join("/")}`,
          ...(credit && { credit }),
        });
      }
    }
  };
  await walk(root, "", null);
  return items;
}
