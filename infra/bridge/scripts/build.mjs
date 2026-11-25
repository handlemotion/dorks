// Bundles src/cli.ts into one self-contained file (shared schemas included), so the base snapshot only
// needs Node: copy dist/cli.mjs into the image as `dorks-bridge`.
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = process.env.DORKS_BUILD_OUT || `${root}dist/cli.mjs`; // the tests build into a temp dir of their own
// The preview overlay (overlay/overlay.ts) runs in the previewed page, not in Node: bundled for the browser first, then inlined into
// the bridge as a string the preview proxy serves (src/preview-proxy.ts).
const overlay = await build({
  entryPoints: [`${root}overlay/overlay.ts`],
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2020",
  format: "iife",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
await build({
  define: { __DORKS_OVERLAY__: JSON.stringify(overlay.outputFiles[0].text) },
  entryPoints: [`${root}src/cli.ts`],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);" },
  external: ["bufferutil", "utf-8-validate"], // optional speedups of `ws`; it falls back to plain JS without them
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
