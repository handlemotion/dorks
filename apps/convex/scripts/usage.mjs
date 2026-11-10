// Measures what one realistic turn costs in Convex terms: client subscription pushes (they count as function calls) and bytes
// re-read per push. Two clients on the same dork (web + iOS). Sim: 300 text deltas at 100ms = a 30s streaming turn.
import { spawn } from "node:child_process";
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { codeFor, startMockResend } from "./mock-resend.mjs";

const { CONVEX_URL, CONVEX_SITE_URL } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await startMockResend();
const host = spawn("node", ["../../infra/bridge-sim/host.mjs"], { env: { ...process.env, SIM_DELTAS: "300", SIM_DELTA_GAP_MS: "100" }, stdio: "ignore" });
const H = { "content-type": "application/json", origin: "http://localhost:3000" };
const email = `usage${Date.now() % 100000}@example.com`;
await fetch(CONVEX_SITE_URL + "/api/auth/email-otp/send-verification-otp", { method: "POST", headers: H, body: JSON.stringify({ email, type: "sign-in" }) });
await sleep(300);
const r = await fetch(CONVEX_SITE_URL + "/api/auth/sign-in/email-otp", { method: "POST", headers: H, body: JSON.stringify({ email, otp: codeFor(email) }) });
const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const mk = () => { const c = new ConvexClient(CONVEX_URL); c.setAuth(async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: "http://localhost:3000" } })).json()).token); return c; };
const web = mk(), ios = mk();
await web.mutation(api.settings.setClaudeToken, { token: "sk-usage" });
await web.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });
const dorkId = await web.mutation(api.dorks.create, { repo: "o/r", message: "first" });

let counting = false;
const stats = { eventsPushes: 0, eventsBytes: 0, dorkPushes: 0, listPushes: 0 };
let latest = [];
let dork = null;
const subscribe = (c, lead) => {
  c.onUpdate(api.events.list, { dorkId, paginationOpts: { numItems: 40, cursor: null } }, (res) => { if (counting) { stats.eventsPushes++; stats.eventsBytes += JSON.stringify(res).length; } if (lead) latest = res.page; });
  c.onUpdate(api.dorks.get, { dorkId }, (d) => { if (counting) stats.dorkPushes++; if (lead) dork = d; });
  c.onUpdate(api.dorks.list, {}, () => counting && stats.listPushes++);
};
subscribe(web, true); subscribe(ios, false);
const waitIdle = async (turns) => { for (let i = 0; i < 600; i++) { await sleep(200); if (dork?.state === "idle" && latest.filter((e) => e.type === "turn_complete").length >= turns) return; } throw new Error("timeout"); };
await waitIdle(1); // first turn
await sleep(500);
counting = true;
const tStart = Date.now();
await web.mutation(api.dorks.sendMessage, { dorkId, text: "measured turn" });
await waitIdle(2);
await sleep(1000);
const secs = (Date.now() - tStart) / 1000;
counting = false;
console.log(JSON.stringify({ secs, clients: 2, bothClients: stats, perClientEventsPushes: stats.eventsPushes / 2, avgBytesPerPush: Math.round(stats.eventsBytes / Math.max(stats.eventsPushes, 1)) }, null, 1));
host.kill("SIGKILL");
process.exit(0);
