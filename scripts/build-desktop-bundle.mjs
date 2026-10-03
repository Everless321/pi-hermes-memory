#!/usr/bin/env node
// Single-file ESM build for PI-Desktop's bundled `pi.hermes-memory` plugin.
// The host provides typebox and @earendil-works/* (and @pi-desktop/extension-host);
// SQLite comes from node:sqlite, so better-sqlite3 is left out on purpose.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const outfile = process.argv[2] ?? fileURLToPath(new URL("../dist/desktop/index.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "inline",
  external: ["typebox", "typebox/*", "@sinclair/*", "@earendil-works/*", "@pi-desktop/*", "better-sqlite3", "bun:sqlite"],
  banner: { js: 'import { createRequire as __hermesCreateRequire } from "node:module"; const require = __hermesCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
console.log(outfile);
