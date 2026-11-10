// Bundles src/cli.ts into one self-contained file (shared schemas included), so the base snapshot only
// needs Node: copy dist/cli.mjs into the image as `dorks-bridge`.
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = process.env.DORKS_BUILD_OUT || `${root}dist/cli.mjs`; // the tests build into a temp dir of their own
await build({
  entryPoints: [`${root}src/cli.ts`],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
