// End-to-end acceptance run against a local Convex backend, with the sim bridge host standing in for Upstash Box.
//   env: CONVEX_URL, CONVEX_SITE_URL, SIM_HOST_KEY, BRIDGE_SECRET_KEY, GITHUB_WEBHOOK_SECRET (read from `convex env`), SECRETS_OUT (file for the scan)
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { codeFor, inbox, startMockResend } from "./mock-resend.mjs";

const { CONVEX_URL, CONVEX_SITE_URL, SIM_HOST_KEY, BRIDGE_SECRET_KEY, GITHUB_WEBHOOK_SECRET } = process.env;
const ORIGIN = "http://localhost:3000";
const H = { "content-type": "application/json", origin: ORIGIN };
const CLAUDE_TOKEN = process.env.E2E_CLAUDE_TOKEN ?? "sk-ant-oat01-SUPERSECRET-e2e"; // set E2E_CLAUDE_TOKEN to run the loop against the real CLI
const CLI_SECRET = "cf-secret-e2e";
const results = [];
const seenByClients = []; // every query result any client saw (scanned for secrets at the end)
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(100); } };
const post = (p, body, headers = {}) => fetch(CONVEX_SITE_URL + p, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify(body) });
// Limits are per hour and persist in the backend, so every run uses fresh addresses for the burst checks below. Caps default to
// the production values; set OTP_SEND_PER_EMAIL / OTP_SEND_PER_IP on the deployment and here to change them. A run spends ~40 of the
// 100/h global send budget, so run-e2e.sh clears the counters first; calling this file directly twice in an hour can hit OTP_SEND_GLOBAL.
const RUN = Date.now().toString(36);
const SEND_CAP = Number(process.env.OTP_SEND_PER_EMAIL ?? 5);
const IP_CAP = Number(process.env.OTP_SEND_PER_IP ?? 30);
const OTP = "/api/auth/email-otp/send-verification-otp";

await startMockResend();

// ---- rate limits (H4). Run before anything else signs in so a burst can't have been pre-counted.
{
  const burst = async (email, n, path = OTP, headers = {}) => {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push((await post(path, { email, type: "sign-in" }, headers)).status);
    return statuses;
  };
  const email = `burst-${RUN}@dorks.build`;
  const before = inbox.length;
  const st = await burst(email, SEND_CAP + 5);
  const delivered = inbox.length - before;
  check(`send burst: first ${SEND_CAP} succeed, the rest get 429`, st.slice(0, SEND_CAP).every((s) => s === 200) && st.slice(SEND_CAP).every((s) => s === 429), st.join(","));
  check("no mail captured beyond the per-email cap", delivered === SEND_CAP, `${delivered} mails`);
  const limited = await post(OTP, { email, type: "sign-in" });
  check("429 body says too many attempts", limited.status === 429 && /too many/i.test((await limited.json()).message ?? ""));
  const alias = `Burst-${RUN}+x@DORKS.build`;
  check("case and +tag variants of the same mailbox share the budget", (await post(OTP, { email: alias, type: "sign-in" })).status === 429);
  check("password-reset route cannot bypass the send cap", (await post("/api/auth/email-otp/request-password-reset", { email })).status === 429);
  check("a different mailbox is unaffected", (await post(OTP, { email: `calm-${RUN}@dorks.build`, type: "sign-in" })).status === 200);

  const vEmail = `verify-${RUN}@dorks.build`;
  await post(OTP, { email: vEmail, type: "sign-in" });
  const vs = [];
  for (let i = 0; i < 15; i++) vs.push((await post("/api/auth/sign-in/email-otp", { email: vEmail, otp: "000000" })).status);
  check("wrong guesses are never rate limited (an outsider cannot lock a user out by guessing)", vs.every((s) => s !== 429), vs.join(","));
  const right = codeFor(vEmail);
  check("the code is already void after 3 wrong guesses (better-auth's own cap)", (await post("/api/auth/sign-in/email-otp", { email: vEmail, otp: right })).status !== 200);

  // Per IP: the local backend adds no x-forwarded-for, so the test supplies one (the limiter trusts the last hop).
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const ipStatuses = [];
  for (let i = 0; i < IP_CAP + 2; i++) ipStatuses.push((await post(OTP, { email: `ip-${RUN}-${i}@dorks.build`, type: "sign-in" }, { "x-forwarded-for": `203.0.113.9, ${ip}` })).status);
  check(`per-IP cap: ${IP_CAP} sends across different mailboxes, then 429`, ipStatuses.slice(0, IP_CAP).every((s) => s === 200) && ipStatuses.slice(IP_CAP).every((s) => s === 429), ipStatuses.slice(-4).join(","));
  const spoof = await post(OTP, { email: `ip2-${RUN}@dorks.build`, type: "sign-in" }, { "x-forwarded-for": `${ip}, 198.51.100.7` });
  // Documents the trust model rather than proving protection: the IP key is the LAST hop, so a caller who controls the whole header gets any key.
  check("per-IP key is the last x-forwarded-for hop (earlier hops are ignored)", spoof.status === 200);
}

async function signIn(email) {
  await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  const code = await waitFor(() => codeFor(email), "otp mail");
  const r = await post("/api/auth/sign-in/email-otp", { email, otp: code });
  if (r.status !== 200) throw new Error(`sign-in ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const tok = async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: ORIGIN } })).json()).token;
  return { email, tok };
}
// Unique per run: the 5 sends/hour budget would otherwise run out after a few local re-runs against the same backend.
const wrong = await post("/api/auth/sign-in/email-otp", { email: `rodrigo-${RUN}@dorks.build`, otp: "000000" });
check("wrong code rejected", wrong.status === 400 || wrong.status === 401, `status ${wrong.status}`);
const me = await signIn(`rodrigo-${RUN}@dorks.build`);
check("allowed email gets a code (Resend request shape) and a session", true, `mail from=${inbox.at(-1).from}`);
const other = await signIn(`other-${RUN}@dorks.build`);

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
await A.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });
await A.mutation(api.settings.setSleepMinutes, { minutes: 0.1 }); // 6s
const onboarding = await A.query(api.settings.onboarding, {});
seenByClients.push(onboarding);
check("onboarding query returns booleans only", onboarding.claudeToken === true && !JSON.stringify(onboarding).includes(CLAUDE_TOKEN));
const code = async (p) => (await p.then(() => null, (e) => e))?.data?.code;
check("claude token over 4KB rejected", (await code(A.mutation(api.settings.setClaudeToken, { token: "x".repeat(4097) }))) === "invalid");
check("cli secret over 16KB rejected", (await code(A.mutation(api.settings.setCliSecret, { name: "BIG", value: "x".repeat(16 * 1024 + 1) }))) === "invalid");
check("NaN / Infinity sleep minutes rejected", (await code(A.mutation(api.settings.setSleepMinutes, { minutes: NaN }))) === "invalid" && (await code(A.mutation(api.settings.setSleepMinutes, { minutes: Infinity }))) === "invalid");
check("rejected sleep minutes left the stored value alone", (await A.query(api.settings.onboarding, {})).sleepMinutes === 0.1);
for (const repo of ["./x", "o/..", "../r", "a b/c"]) check(`repo refused: ${repo}`, (await code(A.mutation(api.dorks.create, { repo, message: "hi" }))) === "invalid");
check("title over 120 chars refused", (await code(A.mutation(api.dorks.create, { repo: "o/r", message: "hi", title: "t".repeat(121) }))) === "invalid");
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

// ------------------------------------------------------------------ github webhook
{
  const body = (extra = {}) => JSON.stringify({
    action: "closed", pull_request: { number: 7, merged: true, head: { sha: "c0ffee1", ref: "agent/x" }, base: { ref: "main" } },
    repository: { full_name: "jaantonio/demo" }, installation: { id: 1 }, sender: { login: "alice", type: "User" }, ...extra,
  });
  const sig = (raw, secret = GITHUB_WEBHOOK_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const hook = (event, raw, { id = `e2e-${RUN}-${Math.random()}`, signature = sig(raw) } = {}) =>
    fetch(`${CONVEX_SITE_URL}/github/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": id, ...(signature ? { "x-hub-signature-256": signature } : {}) }, body: raw }).then((r) => r.status);
  const live = async () => (await A.query(api.subscriptions.list, { dorkId })).map((s) => s.number);

  await A.mutation(api.subscriptions.subscribe, { dorkId, repo: "jaantonio/demo", number: 7 });
  check("subscribed to a PR", (await live()).includes(7));
  const raw = body();
  check("unsigned webhook refused", (await hook("pull_request", raw, { signature: null })) === 401);
  check("webhook signed with another secret refused", (await hook("pull_request", raw, { signature: sig(raw, "not-the-secret") })) === 401);
  check("ping acknowledged", (await hook("ping", JSON.stringify({ zen: "x", hook_id: 1 }))) === 200);
  check("event from another installation acknowledged but not routed", (await hook("pull_request", body({ installation: { id: 999 } }))) === 200 && (await live()).includes(7));
  check("closed PR ends the subscription", (await hook("pull_request", raw, { id: `e2e-${RUN}-close` })) === 200 && !(await live()).includes(7));
  const ended = () => A.query(api.events.list, { dorkId, paginationOpts: { numItems: 200, cursor: null } }).then((r) => r.page.filter((e) => e.type === "subscription" && e.status === "ended"));
  check("the transcript says why", (await ended()).some((e) => e.number === 7 && e.reason === "merged"));
  check("redelivery is acknowledged and changes nothing", (await hook("pull_request", raw, { id: `e2e-${RUN}-close` })) === 200 && (await ended()).filter((e) => e.number === 7).length === 1);
}

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
