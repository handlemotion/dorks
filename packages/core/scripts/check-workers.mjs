// Proves @dorks/core runs on Cloudflare Workers (the Dorks Cloud Worker imports it): bundles src/index.ts with its dependencies
// (@dorks/shared, effect, zod) for a neutral platform, fails on any Node built-in it reaches, then runs the bundle in workerd
// (Miniflare) without nodejs_compat and calls one function of each module there: the reducer, WebCrypto envelopes, bridge auth,
// schedules, the normalizer, the notification renderer and the Boat driver over fetch.
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const reached = [];
const noNode = {
  name: "no-node",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith("node:") || builtins.has(args.path)) {
        reached.push(`${args.path} (imported by ${args.importer})`);
        return { path: args.path, external: true };
      }
    });
  },
};

const worker = `
import * as core from "./src/index.ts";
import { Effect } from "effect";
export default {
  async fetch() {
    const out = {};
    out.reduce = core.reduce({ state: "sleeping", archived: false, hasBox: true, queued: false }, { t: "user_message" }).state;
    const ring = { current: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) } };
    const env = await core.encrypt(ring, "secret", core.aad.claudeToken("u1"));
    out.crypto = await core.decrypt(ring, env.value, core.aad.claudeToken("u1"));
    out.bridgeSecret = (await core.bridgeSecret(btoa("k".repeat(32)), "dork-1")).length > 0;
    out.nextFire = typeof core.nextFire({ every: "day", day: 1, time: "09:00", timezone: "Europe/Berlin" }, Date.UTC(2026, 0, 1));
    out.normalize = core.createNormalizer()({ type: "system", subtype: "init", session_id: "s1" })[0]?.kind;
    out.notify = typeof core.renderNotification;
    const call = core.makeBoatCall({ apiKey: "k", fetch: async () => Response.json({ sandbox: { id: "bx_23456789", state: "running" } }) });
    const box = await Effect.runPromise(core.getSandbox(call, "bx_23456789"));
    out.boat = box._tag === "Some" ? box.value.state : "none";
    return Response.json(out);
  },
};`;

const root = fileURLToPath(new URL("..", import.meta.url));
const result = await build({
  stdin: { contents: worker, resolveDir: root, sourcefile: "worker.ts", loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser", "import", "default"],
  plugins: [noNode],
  logLevel: "silent",
});
if (reached.length) {
  console.error(`@dorks/core reaches Node built-ins, which Cloudflare Workers do not have:\n  ${reached.join("\n  ")}`);
  process.exit(1);
}
const script = result.outputFiles[0].text;

const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-11-01" }));
try {
  const res = await mf.dispatchFetch("http://core.test/");
  const body = await res.text();
  if (!res.ok) throw new Error(`worker answered ${res.status}: ${body}`);
  const out = JSON.parse(body);
  const want = { reduce: "waking", crypto: "secret", bridgeSecret: true, nextFire: "number", normalize: "session", notify: "function", boat: "running" };
  for (const [k, v] of Object.entries(want)) if (out[k] !== v) throw new Error(`${k}: got ${JSON.stringify(out[k])}, want ${JSON.stringify(v)}`);
  console.log(`@dorks/core runs in workerd (${(script.length / 1024).toFixed(0)} KiB bundle, no Node built-ins): ${body}`);
} finally {
  await mf.dispose();
}
