// End-to-end test of bring-your-own-Upstash against the REAL Upstash Box API, driving our own Convex functions on the local backend
// (pnpm dev:backend). Nothing is mocked: the "user's" Upstash key is a real key (UPSTASH_BOX_API_KEY from Doppler dev, used here only as a
// stand-in for a customer's own key), the workstation image is really built in that account, and a dork's box really starts from it.
//
//   needs: pnpm dev:backend running; Docker; run from the repo root:  pnpm byok:e2e
//   cost:  a few minutes of one small box (build) + seconds of another, billed to that Upstash account.
//
// What cannot be proven locally: the box's bridge connecting back (the local backend is not reachable from Upstash); that needs a hosted
// deployment. Everything up to "the box exists in the user's account, started from their image, with the bridge installed" is checked here.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { codeFor, startMockResend } from "./mock-resend.mjs";

const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const UPSTASH = "https://us-east-1.box.upstash.com";
const userKey = process.env.UPSTASH_BOX_API_KEY;
if (!userKey || userKey.startsWith("REPLACE_ME__")) throw new Error("UPSTASH_BOX_API_KEY is not set (stands in for the customer's own key)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const sh = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return r.stdout;
};
const convex = (args, input) => sh("npx", ["convex", ...args], input);
const deployed = (n) => { try { return convex(["env", "get", n]).trim(); } catch { return ""; } };
const upstash = (method, path, body) => fetch(`${UPSTASH}${path}`, { method, headers: { "X-Box-Api-Key": userKey, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const errText = (e) => String(e?.data?.message ?? e?.message ?? e).slice(0, 160);
const codeOf = (e) => e?.data?.code ?? (typeof e?.data === "string" ? JSON.parse(e.data).code : undefined);

// The Docker backend has no route to the internet in cloud containers, so its Upstash calls go through this relay on the host
// (UPSTASH_BOX_BASE_URL). Still the real Upstash API; only the transport differs. Async handlers, so it keeps answering while we wait.
const PORT = 8788;
const relay = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const headers = {};
    for (const h of ["x-box-api-key", "content-type"]) if (req.headers[h]) headers[h] = req.headers[h];
    try {
      const r = await fetch(`${UPSTASH}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.writeHead(502).end("{}");
    }
  });
});
await new Promise((r) => relay.listen(PORT, "127.0.0.1", r));

const prevProvider = deployed("BOX_PROVIDER");
await startMockResend();
const H = { "content-type": "application/json", origin: "http://localhost:3000" };
const email = `byok${Date.now() % 100000}@dorks.build`;
await fetch(CONVEX_SITE_URL + "/api/auth/email-otp/send-verification-otp", { method: "POST", headers: H, body: JSON.stringify({ email, type: "sign-in" }) });
await sleep(400);
const r = await fetch(CONVEX_SITE_URL + "/api/auth/sign-in/email-otp", { method: "POST", headers: H, body: JSON.stringify({ email, otp: codeFor(email) }) });
const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const client = new ConvexClient(CONVEX_URL);
client.setAuth(async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: "http://localhost:3000" } })).json()).token);

let dork, snapshotId, boxId;
try {
  // Sim phase: the simulated GitHub link only works while BOX_PROVIDER=sim.
  convex(["env", "set", "BOX_PROVIDER", "sim"]);
  await client.mutation(api.settings.setClaudeToken, { token: "sk-byok-e2e" });
  await client.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });
  convex(["env", "set", "UPSTASH_BOX_BASE_URL", `http://127.0.0.1:${PORT}`]);
  convex(["env", "set", "BOX_PROVIDER", "upstash"]);

  // Publish the bridge bundle exactly like a deploy does.
  const pub = sh("node", ["scripts/publish-bridge.mjs"]);
  check("bridge bundle published to the deployment", /\[publish-bridge\] \d+ bytes/.test(pub), pub.trim());

  // Gate: no key yet
  let err;
  try { await client.mutation(api.dorks.create, { repo: "o/r", message: "byok e2e" }); } catch (e) { err = e; }
  check("dorks.create is refused without an Upstash key", codeOf(err) === "onboarding_incomplete", errText(err));

  // Key: a wrong key is refused by real Upstash, the right one is accepted and stored encrypted
  err = undefined;
  try { await client.action(api.settings.setUpstashKey, { key: "definitely-not-a-key" }); } catch (e) { err = e; }
  check("a wrong Upstash key is rejected (checked against real Upstash)", codeOf(err) === "invalid", errText(err));
  await client.action(api.settings.setUpstashKey, { key: userKey });
  let ob = await client.query(api.settings.onboarding, {});
  check("the right key is accepted; onboarding shows a boolean only", ob.upstashKey === true && !JSON.stringify(ob).includes(userKey));
  const stored = convex(["data", "userSettings", "--format", "json"]);
  check("the key is stored encrypted, not in plaintext", !stored.includes(userKey) && /"upstashKeyEnc":\s*"v1:/.test(stored));

  err = undefined;
  try { await client.mutation(api.dorks.create, { repo: "o/r", message: "byok e2e" }); } catch (e) { err = e; }
  check("dorks.create is still refused until the image is built", codeOf(err) === "onboarding_incomplete", errText(err));

  // Image: really built in the user's Upstash account
  const t0 = Date.now();
  const built = await client.action(api.workstation.provision, {});
  snapshotId = built.snapshotId;
  ob = await client.query(api.settings.onboarding, {});
  check("the workstation image was built in the user's account", !!snapshotId && ob.workstation === "ready", `${snapshotId} in ${Math.round((Date.now() - t0) / 1000)}s`);

  // Dork: the box is created with the USER's key from the USER's image
  dork = await client.mutation(api.dorks.create, { repo: "o/r", message: "byok e2e" });
  let row;
  for (let i = 0; i < 120 && !row?.boxId; i++) { await sleep(2000); row = await client.query(api.dorks.get, { dorkId: dork }); }
  boxId = row?.boxId;
  check("dorks.create started a box", !!boxId, boxId);
  const box = await (await upstash("GET", `/v2/box/${boxId}`)).json();
  check("that box exists in the user's own Upstash account", box?.id === boxId && ["idle", "running"].includes(box.status), `${box?.status}`);
  const ex = await (await upstash("POST", `/v2/box/${boxId}/exec`, { command: ["sh", "-c", "command -v dorks-bridge && command -v dorks && test \"$(command -v gh)\" = /usr/local/bin/gh && claude --version"] })).json();
  check("the box has the bridge, dorks, the gh shim and Claude Code (it started from the user's image)", ex.exit_code === 0, String(ex.output ?? "").trim().replace(/\n/g, " | ").slice(0, 120));

  // Cleanup through our own code: removing the dork deletes the box with the user's key
  await client.mutation(api.dorks.remove, { dorkId: dork });
  dork = undefined;
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { const g = await upstash("GET", `/v2/box/${boxId}`); gone = g.status === 404 || (g.ok && (await g.json()).status === "deleted"); if (!gone) await sleep(2000); }
  check("removing the dork deleted the box from the user's account", gone);
  boxId = undefined;
} catch (e) {
  results.push(false);
  console.error("FAIL", e instanceof Error ? e.message : e);
} finally {
  try { if (dork) await client.mutation(api.dorks.remove, { dorkId: dork }); } catch {}
  try { if (boxId) await upstash("DELETE", `/v2/box/${boxId}`); } catch {}
  try { if (snapshotId) await upstash("DELETE", "/v2/box/snapshots", { ids: [snapshotId] }); } catch {}
  try { convex(["env", "remove", "UPSTASH_BOX_BASE_URL"]); } catch {}
  try { if (prevProvider) convex(["env", "set", "BOX_PROVIDER", prevProvider]); else convex(["env", "remove", "BOX_PROVIDER"]); } catch {}
  relay.close();
  await client.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
