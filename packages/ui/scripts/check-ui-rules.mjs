// Fails when app code or the theme CSS uses a drop shadow. The UI rule is "no drop shadows, ever" (see README.md, "Design rules"): the
// theme switches every Tailwind shadow token off (src/glass.css), so a `shadow-*` class in the published shadcn / AI Elements files is
// a harmless no-op, but nothing WE write may use one.
//
//   node packages/ui/scripts/check-ui-rules.mjs        (also run by `pnpm test`)
//
// Scans: apps/web/src, packages/ui/src/*.css and the app files in packages/ui/src outside components/ui and components/ai-elements
// (those are third-party sources kept as published). Flags `shadow-<anything but none>`, `box-shadow`, `drop-shadow`, `text-shadow`
// and `filter: drop-shadow(`. A line carrying `ui-rules: allow` is skipped: that is how the theme override itself is written.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCAN = ["apps/web/src", "packages/ui/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "components/ui", "components/ai-elements"]);
const SKIP_FILES = new Set(["routeTree.gen.ts", "markdown.tsx"]);
const EXT = /\.(css|tsx?|jsx?|mjs)$/;
const RULES = [
  [/(?<![\w-])shadow-(?!none\b)[\w[\]/.-]+/, "shadow utility class"],
  [/(?<![\w-])(box|drop|text)-shadow\b/, "box-shadow / drop-shadow / text-shadow"],
  [/(?<![\w-])inset-shadow-/, "inset-shadow utility class"],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (SKIP_FILES.has(name) || [...SKIP_DIRS].some((d) => rel.includes(`/${d}`) || name === d)) continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXT.test(name)) yield full;
  }
}

const found = [];
for (const base of SCAN) {
  for (const file of walk(join(root, base))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("ui-rules: allow")) return;
      for (const [re, what] of RULES) if (re.test(line)) found.push(`${relative(root, file)}:${i + 1}  ${what}: ${line.trim().slice(0, 100)}`);
    });
  }
}

if (found.length) {
  console.error(`UI rule broken: no drop shadows. Separate surfaces with fill, spacing and glass layering instead.\n${found.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("ui rules: no shadows in app code or theme CSS");
