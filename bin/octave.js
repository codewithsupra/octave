#!/usr/bin/env node
// `octave` CLI: boots the local server (TypeScript via tsx, no build step for the server).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { register } from "tsx/esm/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(path.join(root, "dist", "index.html"))) {
  console.error("Octave's UI isn't built yet. Run `npm run build` in", root);
  process.exit(1);
}
const port = process.argv.find((a) => a.startsWith("--port="));
if (port) process.env.OCTAVE_PORT = port.split("=")[1];
register();
await import("../server/index.ts");
