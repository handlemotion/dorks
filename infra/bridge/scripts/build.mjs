// Bundles src/cli.ts into one self-contained file (convex client + shared schemas included), so the base snapshot only
// needs Node: copy dist/cli.mjs into the image as `dorks-bridge`.
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [`${root}src/cli.ts`],
  outfile: `${root}dist/cli.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
chmodSync(`${root}dist/cli.mjs`, 0o755);
console.log("built infra/bridge/dist/cli.mjs");
