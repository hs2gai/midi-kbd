// Path definitions shared by the local server (server.mjs) and the deploy build (scripts/build.mjs).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url));
// Where the instrument lives. Defaults to sfz/ in the project root (not tracked by git). Set the SFZ_ROOT env var to use another location
export const SFZ_ROOT = process.env.SFZ_ROOT ?? resolve(PROJECT_ROOT, "sfz");

// URL prefix -> actual directory. All other paths are served from PROJECT_ROOT.
export const MOUNTS = {
  "/sfz/": SFZ_ROOT,
  "/vendor/vexflow/": resolve(PROJECT_ROOT, "node_modules/vexflow/build/esm"),
};
