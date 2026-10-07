// End-to-end acceptance run against a local Convex backend, with the sim bridge host standing in for Upstash Box.
//   env: CONVEX_URL, CONVEX_SITE_URL, SIM_HOST_KEY, BRIDGE_SECRET_KEY (read from `convex env`), SECRETS_OUT (file for the scan)
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { codeFor, inbox, startMockResend } from "./mock-resend.mjs";

const { CONVEX_URL, CONVEX_SITE_URL, SIM_HOST_KEY, BRIDGE_SECRET_KEY } = process.env;
const ORIGIN = "http://localhost:3000";
const H = { "content-type": "application/json", origin: ORIGIN };
const CLAUDE_TOKEN = "sk-ant-oat01-SUPERSECRET-e2e";
const CLI_SECRET = "cf-secret-e2e";
const results = [];
const seenByClients = []; // every query result any client saw (scanned for secrets at the end)
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(100); } };
const post = (p, body) => fetch(CONVEX_SITE_URL + p, { method: "POST", headers: H, body: JSON.stringify(body) });

await startMockResend();

// ------------------------------------------------------------------ 1. auth
for (const email of ["eve@evil.com", "a@jaantonio.com.evil.com", "a@evil.com@jaantonio.com", "@jaantonio.com"]) {
  const r = await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  check(`send code refused: ${email}`, r.status === 403, `status ${r.status}`);
}
check("no mail sent to foreign addresses", inbox.length === 0);
check("foreign sign-in refused", (await post("/api/auth/sign-in/email-otp", { email: "eve@evil.com", otp: "123456" })).status === 403);

async function signIn(email) {
  await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  const code = await waitFor(() => codeFor(email), "otp mail");
  const r = await post("/api/auth/sign-in/email-otp", { email, otp: code });
  if (r.status !== 200) throw new Error(`sign-in ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const tok = async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: ORIGIN } })).json()).token;
  return { email, tok };
}
const wrong = await post("/api/auth/sign-in/email-otp", { email: "rodrigo@jaantonio.com", otp: "000000" });
check("wrong code rejected", wrong.status === 400 || wrong.status === 401, `status ${wrong.status}`);
const me = await signIn("rodrigo@jaantonio.com");
check("allowed email gets a code (Resend request shape) and a session", true, `mail from=${inbox.at(-1).from}`);
const other = await signIn("other@jaantonio.com");

const mkClient = async (who) => {
  const c = new ConvexClient(CONVEX_URL);
  c.setAuth(who.tok);
  return c;
};
const A = await mkClient(me);
const B = await mkClient(other);

// ------------------------------------------------------------------ onboarding
await A.mutation(api.settings.setClaudeToken, { token: CLAUDE_TOKEN });
await A.mutation(api.settings.setCliSecret, { name: "CF_TOKEN", value: CLI_SECRET });
await A.mutation(api.settings.setGithubInstallation, { installationId: 1 });
await A.mutation(api.settings.setSleepMinutes, { minutes: 0.1 }); // 6s
const onboarding = await A.query(api.settings.onboarding, {});
seenByClients.push(onboarding);
check("onboarding query returns booleans only", onboarding.claudeToken === true && !JSON.stringify(onboarding).includes(CLAUDE_TOKEN));
let err = await B.mutation(api.dorks.create, { repo: "o/r", message: "hi" }).then(() => null, (e) => e);
check("create blocked until onboarding is done", err?.data?.code === "onboarding_incomplete", err?.data?.code);

// ------------------------------------------------------------------ helpers over the live subscription
function watch(client, dorkId, tag) {
  const w = { tag, snapshots: [], latest: [], dork: null, unsub: [] };
  w.unsub.push(client.onUpdate(api.events.list, { dorkId, paginationOpts: { numItems: 200, cursor: null } }, (r) => { seenByClients.push(r); w.latest = [...r.page].reverse(); w.snapshots.push(w.latest.map((e) => e.seq)); }));
  w.unsub.push(client.onUpdate(api.dorks.get, { dorkId }, (d) => { seenByClients.push(d); w.dork = d; }));
  return w;
}
const stop = (w) => w.unsub.forEach((u) => u());
const types = (w) => w.latest.map((e) => e.type);
const statuses = (w) => w.latest.filter((e) => e.type === "status").map((e) => e.state);
const dense = (seqs) => seqs.every((s, i) => s === (seqs[0] ?? 1) + i) && new Set(seqs).size === seqs.length;
const bridgeSecret = (id) => createHmac("sha256", BRIDGE_SECRET_KEY).update(`bridge|${id}`).digest("hex");

// ------------------------------------------------------------------ 2. lifecycle with live streaming
const t0 = Date.now();
const dorkId = await A.mutation(api.dorks.create, { repo: "jaantonio/demo", message: "add a readme" });
const wa = watch(A, dorkId, "A");
await waitFor(() => wa.dork?.state === "idle", "dork idle after first turn", 40_000);
check("create dork -> box -> bridge ready -> first turn -> idle", true, `${Date.now() - t0}ms`);
check("status events in order", JSON.stringify(statuses(wa).slice(0, 3)) === JSON.stringify(["creating", "working", "idle"]) || JSON.stringify(statuses(wa)).includes('"working","idle"'), JSON.stringify(statuses(wa)));
check("turn streamed: delta..message..tool..turn_complete", ["user_message", "assistant_delta", "assistant_message", "tool_use", "tool_result", "turn_complete"].every((t) => types(wa).includes(t)), types(wa).join(","));
const session1 = wa.dork.claudeSessionId;
check("claude session id captured", !!session1, session1);
const bridgeViews = [];
const spy = new ConvexClient(CONVEX_URL); // plays the bridge to record what the commands subscription ever carries
spy.onUpdate(api.bridge.commands, { dorkId, secret: bridgeSecret(dorkId) }, (c) => bridgeViews.push(c));

// ---- second turn: kill + reopen a client mid-turn
const seqBefore2 = wa.latest.at(-1).seq;
await A.mutation(api.dorks.sendMessage, { dorkId, text: "now add a license" });
let C = await mkClient(me);
let wc = watch(C, dorkId, "C1");
// mid-turn = turn 2 has streamed some text but not completed
await waitFor(() => wa.latest.some((e) => e.seq > seqBefore2 && e.type === "assistant_delta") && !wa.latest.some((e) => e.seq > seqBefore2 && e.type === "turn_complete") && wc.latest.at(-1)?.seq === wa.latest.at(-1)?.seq, "mid-turn", 20_000);
const midSeqs = wc.latest.map((e) => e.seq);
const midLen = JSON.stringify(wc.latest).length;
stop(wc); await C.close(); // kill the client mid-turn
await sleep(700); // events keep arriving while it is gone
C = await mkClient(me);
wc = watch(C, dorkId, "C2");
await waitFor(() => wc.snapshots.length > 0, "first snapshot after reopen");
const firstSnapLen = JSON.stringify(wc.latest).length;
await waitFor(() => wa.dork?.state === "idle" && wa.latest.at(-1)?.type === "status", "turn finished", 40_000);
await waitFor(() => wc.latest.at(-1)?.seq === wa.latest.at(-1)?.seq, "reopened client caught up");
const same = JSON.stringify(wc.latest) === JSON.stringify(wa.latest);
check("reopened client sees exactly what the always-on client sees", same, `${wc.latest.length} events`);
check("no gaps, no dupes (dense seq 1..n) in every snapshot of every client", [...wa.snapshots, ...wc.snapshots].every(dense) && wa.latest[0].seq === 1, `last seq ${wa.latest.at(-1).seq}`);
check("killed mid-turn: reopened client's first snapshot already includes what was stored while it was gone", dense(wc.snapshots[0]) && wc.snapshots.length > 0 && firstSnapLen > midLen, `at kill: ${midSeqs.length} events/${midLen}B -> first snapshot after reopen: ${firstSnapLen}B -> final seq ${wa.latest.at(-1).seq}`);
check("the turn was still streaming when the client was killed", !types(wa).slice(0, midSeqs.length).includes("turn_complete") || types(wa).slice(0, midSeqs.length).filter((t) => t === "turn_complete").length === 1);
const pushes = wa.snapshots.length;

// ---- sleep timer, wake on message with the same claude session
await waitFor(() => wa.dork?.state === "sleeping", "sleep timer paused the dork", 30_000);
check("idle -> sleep timer -> sleeping (box paused)", true);
await sleep(1500);
check("sleeping dork stays asleep (bridge connect does not wake it)", wa.dork.state === "sleeping");
await A.mutation(api.dorks.sendMessage, { dorkId, text: "wake up and add .gitignore" });
await waitFor(() => wa.dork?.state === "working" || wa.dork?.state === "waking", "waking");
await waitFor(() => wa.dork?.state === "idle" && wa.latest.filter((e) => e.type === "turn_complete").length === 3, "third turn done", 60_000);
check("message wakes it; same claude session resumed", wa.dork.claudeSessionId === session1, wa.dork.claudeSessionId);
check("woke through waking -> working", JSON.stringify(statuses(wa)).includes('"sleeping","waking","working"'), JSON.stringify(statuses(wa)));
check("dense after wake (bridge numbering continued)", dense(wa.latest.map((e) => e.seq)));

// ---- archive pauses, unarchive does not wake, message rejected
await A.mutation(api.dorks.setArchived, { dorkId, archived: true });
await waitFor(() => wa.dork?.state === "sleeping" && wa.dork.archived, "archive paused", 30_000);
check("archive pauses the dork", true);
await A.mutation(api.dorks.setArchived, { dorkId, archived: false });
await sleep(2500);
check("unarchive does not wake", wa.dork.state === "sleeping" && !wa.dork.archived, wa.dork.state);
await A.mutation(api.dorks.setArchived, { dorkId, archived: true });
const before = wa.latest.length;
err = await A.mutation(api.dorks.sendMessage, { dorkId, text: "should be rejected" }).then(() => null, (e) => e);
await sleep(500);
check("message to archived dork rejected", err?.data?.code === "archived", err?.data?.code);
check("rejected message left no trace (event or outbox)", wa.latest.length === before && !JSON.stringify(wa.latest).includes("should be rejected"));
err = await B.query(api.dorks.get, { dorkId });
check("other user cannot read the dork", err === null);
const evs = await B.query(api.events.list, { dorkId, paginationOpts: { numItems: 10, cursor: null } });
check("other user cannot read its events", evs.page.length === 0);
err = await B.mutation(api.dorks.sendMessage, { dorkId, text: "x" }).then(() => null, (e) => e);
check("other user cannot message it", err?.data?.code === "not_found");
err = await new ConvexClient(CONVEX_URL).query(api.dorks.list, {}).then(() => null, (e) => e);
check("unauthenticated calls are refused", !!err);
err = await spy.mutation(api.bridge.heartbeat, { dorkId, secret: "0".repeat(64) }).then(() => null, (e) => e);
check("bridge calls with a wrong secret are refused", err?.data?.code === "forbidden");

// ------------------------------------------------------------------ secrets
const blob = JSON.stringify([seenByClients, bridgeViews]);
const needles = { claudeToken: CLAUDE_TOKEN, cliSecret: CLI_SECRET, ghToken: "sim-github-token", bridgeSecret: bridgeSecret(dorkId) };
for (const [k, n] of Object.entries(needles)) check(`${k} absent from every query result clients/bridge ever received`, !blob.includes(n));
check("bridge commands subscription carried only markers/messages", bridgeViews.flat().every((c) => ["user_message", "interrupt", "flush", "fetch_configure", "fetch_gh_token"].includes(c.frame.t)));
writeFileSync(process.env.SECRETS_OUT ?? "/tmp/needles.json", JSON.stringify(needles));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed; client A saw ${pushes} reactive pushes for the 2nd turn+`);
writeFileSync("/tmp/e2e-stats.json", JSON.stringify({ dorkId, snapshotsA: wa.snapshots.length, events: wa.latest.length }));
for (const c of [A, B, C, spy]) await c.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
