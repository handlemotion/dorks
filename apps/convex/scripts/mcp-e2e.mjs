// End-to-end check of the dorks MCP tools (infra/bridge/src/mcp.ts) through the whole stack: a local Convex backend, the REAL in-box bridge
// (ConvexTransport, the sim host launches it with BRIDGE_IMPL=real) and the REAL Claude CLI. A user message asks the model to subscribe to
// a PR and list its subscriptions with the MCP tools; the script then reads the backend's own tables back as the signed-in user.
// Not part of CI: it needs a real Claude token and costs a few cents. Run it with scripts/run-mcp-e2e.sh.
//   env: CONVEX_URL, CONVEX_SITE_URL, E2E_CLAUDE_TOKEN
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { codeFor, startMockResend } from "./mock-resend.mjs";

const { CONVEX_URL, CONVEX_SITE_URL, E2E_CLAUDE_TOKEN } = process.env;
if (!E2E_CLAUDE_TOKEN) throw new Error("E2E_CLAUDE_TOKEN is required (a real Claude token)");
const ORIGIN = "http://localhost:3000";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  - " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, what, ms = 120_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
const post = (p, body) => fetch(CONVEX_SITE_URL + p, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });

await startMockResend();
const email = `mcp-${Date.now().toString(36)}@dorks.build`;
await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
const code = await waitFor(() => codeFor(email), "otp mail", 30_000);
const signedIn = await post("/api/auth/sign-in/email-otp", { email, otp: code });
if (signedIn.status !== 200) throw new Error(`sign-in ${signedIn.status}`);
const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const client = new ConvexClient(CONVEX_URL);
client.setAuth(async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: ORIGIN } })).json()).token);

await client.mutation(api.settings.setClaudeToken, { token: E2E_CLAUDE_TOKEN });
await client.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" }); // BOX_PROVIDER=sim: no real GitHub App
await client.mutation(api.settings.setSleepMinutes, { minutes: 30 });

const PR = { repo: "jaantonio/demo", number: 7 };
const events = (id) => client.query(api.events.list, { dorkId: id, paginationOpts: { numItems: 200, cursor: null } }).then((r) => [...r.page].reverse());
const toolUses = (evs) => evs.filter((e) => e.type === "tool_use").map((e) => e.name ?? e.tool ?? JSON.stringify(e).match(/mcp__dorks__\w+/)?.[0]);
const idleCount = (evs) => evs.filter((e) => e.type === "turn_complete").length;

const dorkId = await client.mutation(api.dorks.create, {
  repo: "jaantonio/demo",
  provider: "claude",
  message: `Call the pr_subscribe tool of the dorks MCP server with pr ${PR.repo}#${PR.number}, then call the pr_list tool of the same server. Finish by replying with the word DONE and the PR you listed.`,
});
let evs = await waitFor(async () => { const e = await events(dorkId); return idleCount(e) >= 1 && e; }, "first turn complete");
check("the model called pr_subscribe then pr_list through the MCP server", JSON.stringify(toolUses(evs).filter((n) => /^mcp__dorks__/.test(n ?? ""))) === '["mcp__dorks__pr_subscribe","mcp__dorks__pr_list"]', toolUses(evs).join(","));
const subs = await client.query(api.subscriptions.list, { dorkId });
check("the backend stored the subscription, as an agent subscription", subs.length === 1 && subs[0].repo === PR.repo && subs[0].number === PR.number && subs[0].source === "agent", JSON.stringify(subs.map((s) => [s.repo, s.number, s.source, s.status])));
check("a subscription event is in the transcript", evs.some((e) => e.type === "subscription"), evs.map((e) => e.type).filter((t, i, a) => a.indexOf(t) === i).join(","));
check("the model saw the subscription in pr_list and reported DONE", JSON.stringify(evs).includes("DONE") && JSON.stringify(evs).includes(`${PR.repo}#${PR.number}`));

await client.mutation(api.dorks.sendMessage, { dorkId, text: `Call the pr_unsubscribe tool of the dorks MCP server with pr ${PR.repo}#${PR.number}, then call pr_list again and reply with the word GONE if it is empty.` });
evs = await waitFor(async () => { const e = await events(dorkId); return idleCount(e) >= 2 && e; }, "second turn complete");
check("the model called pr_unsubscribe", toolUses(evs).includes("mcp__dorks__pr_unsubscribe"));
const after = await client.query(api.subscriptions.list, { dorkId });
check("the backend ended the subscription", after.every((s) => s.status === "ended") || after.length === 0, JSON.stringify(after.map((s) => [s.repo, s.number, s.status])));

await client.mutation(api.dorks.setArchived, { dorkId, archived: true });
client.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
