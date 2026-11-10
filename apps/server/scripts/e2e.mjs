// End-to-end run against the real server process (the compiled binary, or `bun run src/main.ts`) with the simulated sandbox host:
// UI API over HTTP + SSE, the bridge over a real WebSocket, timers, pause/resume, and a secret scan of everything on disk.
//   node scripts/e2e.mjs            SERVER_BIN=<path> to use a compiled binary (default: bun run src/main.ts)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "../../..");
const dataDir = mkdtempSync(join(tmpdir(), "dorks-e2e-"));
const SIM_HOST_KEY = "e2e-host-key-" + Math.random().toString(36).slice(2);
const CLAUDE = "claude-oauth-token-" + Math.random().toString(36).slice(2);
const GITHUB = "github-token-" + Math.random().toString(36).slice(2);
const CLI_SECRET = "cli-secret-" + Math.random().toString(36).slice(2);
const logs = [];
let lastDork = null;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 30_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
};

const env = { ...process.env, DORKS_DATA_DIR: dataDir, DORKS_UI_PORT: "0", DORKS_BRIDGE_PORT: "0", BOX_PROVIDER: "sim", SIM_HOST_KEY };
delete env.DORKS_PUBLIC_URL;
const [cmd, ...args] = process.env.SERVER_BIN ? [process.env.SERVER_BIN] : ["bun", "run", join(here, "../src/main.ts")];
const server = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => logs.push(String(d)));
const ready = await new Promise((resolve, reject) => {
  let buf = "";
  server.stdout.on("data", (d) => {
    buf += d;
    logs.push(String(d));
    const line = buf.split("\n").find((l) => l.startsWith("{"));
    if (line) resolve(JSON.parse(line));
  });
  server.on("exit", (c) => reject(new Error(`server exited early (${c})`)));
  setTimeout(() => reject(new Error("server did not become ready")), 20_000);
});
const UI = ready.ui;
const secrets = JSON.parse(readFileSync(join(dataDir, "secrets.json"), "utf8"));
const auth = { Authorization: `Bearer ${secrets.ownerToken}` };

const api = async (method, path, body) => {
  const res = await fetch(`${UI}${path}`, { method, headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

const host = spawn("node", [join(root, "infra/bridge-sim/host.mjs")], {
  env: { ...env, SIM_UI_URL: UI, SIM_BRIDGE_URL: ready.bridge, BRIDGE_SECRET_KEY: secrets.bridgeSecretKey, SIM_DELTAS: "20", SIM_DELTA_GAP_MS: "10", HEARTBEAT_MS: "1000" },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stdout.on("data", (d) => logs.push(String(d)));
host.stderr.on("data", (d) => logs.push(String(d)));

const cleanup = () => {
  host.kill("SIGKILL");
  server.kill("SIGTERM");
};
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));

try {
  // ---- auth and surfaces
  check("health needs no token", (await fetch(`${UI}/api/health`)).status === 200);
  check("the API refuses a request without the owner token", (await fetch(`${UI}/api/dorks`)).status === 401);
  check("the API refuses a wrong token", (await fetch(`${UI}/api/dorks`, { headers: { Authorization: "Bearer nope" } })).status === 401);
  const http = ready.bridge.replace(/^ws/, "http");
  check("the bridge listener serves nothing but /bridge", (await fetch(`${http.replace("/bridge", "/")}`)).status === 404);
  const badWs = await new Promise((resolve) => {
    const ws = new WebSocket(ready.bridge);
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", dorkId: "x", secret: "0".repeat(64) }));
    ws.onclose = (e) => resolve(e.code);
    setTimeout(() => resolve("timeout"), 5000);
  });
  check("a bridge socket with a bad secret is closed with 4403", badWs === 4403, String(badWs));

  // ---- onboarding gates
  const early = await api("POST", "/api/dorks", { repo: "acme/demo", message: "hi", provider: "claude" });
  check("creating a dork before onboarding is refused", early.status === 412 && early.json.error.code === "onboarding_incomplete", JSON.stringify(early.json));
  const set = await api("PUT", "/api/settings", { claudeToken: CLAUDE, githubToken: GITHUB, baseSnapshotId: "sim-snap", sleepMinutes: 0.05 });
  check("settings saved", set.status === 200);
  check("secret CLI value saved", (await api("PUT", "/api/secrets/DOPPLER_TOKEN", { value: CLI_SECRET })).status === 200);
  const view = (await api("GET", "/api/settings")).json;
  check("settings never echo secrets", !JSON.stringify(view).includes(CLAUDE) && view.claudeToken === true && view.github.configured === true);
  check("secret names are listed, values are not", JSON.stringify((await api("GET", "/api/secrets")).json) === '["DOPPLER_TOKEN"]');

  // ---- live stream
  const live = [];
  const sse = await fetch(`${UI}/api/live`, { headers: auth });
  check("the live stream opens", sse.status === 200 && (sse.headers.get("content-type") ?? "").includes("text/event-stream"));
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of sse.body) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith("data: ")) live.push(JSON.parse(block.slice(6)));
      }
    }
  })().catch(() => {});

  // ---- a dork's life
  const created = await api("POST", "/api/dorks", { repo: "acme/demo", message: "add a readme", provider: "claude" });
  check("create a dork", created.status === 201 && typeof created.json.id === "string");
  const id = created.json.id;
  lastDork = id;
  const dork = async () => (await api("GET", `/api/dorks/${id}`)).json;
  await until(async () => (await dork()).state === "idle", "first turn finishes and the dork goes idle");
  const events = async () => (await api("GET", `/api/dorks/${id}/events?limit=200`)).json.events.reverse();
  const first = await events();
  check("the transcript has the message, streamed text and a completed turn", ["user_message", "assistant_message", "turn_complete"].every((t) => first.some((e) => e.type === t)), first.map((e) => e.type).join(","));
  check("event seq is dense", first.every((e, i) => e.seq === i + 1));
  check("the state machine left a status trail", first.filter((e) => e.type === "status").map((e) => e.state).join(",").startsWith("creating,working,idle") || first.some((e) => e.type === "status" && e.state === "idle"));
  check("the live stream announced the transcript changes", live.some((m) => m.t === "events" && m.dorkId === id) && live.some((m) => m.t === "dork" && m.dorkId === id), `${live.length} messages`);

  const tail = (await api("GET", `/api/dorks/${id}/events?after=${first.length - 2}`)).json;
  check("tailing with ?after returns the newer events in order", tail.events.length === 2 && tail.events[0].seq === first.length - 1);
  const page = (await api("GET", `/api/dorks/${id}/events?before=${first.length}&limit=2`)).json;
  check("paging backwards with ?before", page.events.length === 2 && page.events[0].seq === first.length - 1 && page.hasMore === true);

  // ---- sleeping and waking (the sleep timer is 3 s)
  await until(async () => (await dork()).state === "sleeping", "the idle dork sleeps (flush, pause)", 40_000);
  check("the dork went to sleep", true);
  const sent = await api("POST", `/api/dorks/${id}/messages`, { text: "and a license" });
  check("a message to a sleeping dork is accepted", sent.status === 200);
  check("it wakes", ["waking", "working", "idle"].includes((await dork()).state));
  await until(async () => (await events()).filter((e) => e.type === "turn_complete").length >= 2, "second turn completes after the wake");
  check("the second turn ran after a resume", true);

  // ---- PR autonomy surfaces
  const sub = await api("POST", `/api/dorks/${id}/subscriptions`, { repo: "Acme/Demo", number: 5 });
  check("subscribe to a PR", sub.status === 200);
  const subs = (await api("GET", `/api/dorks/${id}/subscriptions`)).json;
  check("the subscription is listed with a lowercase repo", subs.length === 1 && subs[0].repo === "acme/demo" && subs[0].source === "user");
  check("unsubscribe", (await api("DELETE", `/api/dorks/${id}/subscriptions`, { repo: "acme/demo", number: 5 })).status === 200 && (await api("GET", `/api/dorks/${id}/subscriptions`)).json.length === 0);

  // ---- housekeeping
  check("rename", (await api("PATCH", `/api/dorks/${id}`, { title: "Readme" })).status === 200 && (await dork()).title === "Readme");
  check("archive", (await api("POST", `/api/dorks/${id}/archive`, { archived: true })).status === 200 && (await dork()).archived === true);
  check("a message to an archived dork is refused", (await api("POST", `/api/dorks/${id}/messages`, { text: "x" })).status === 409);
  check("the archived list holds it", (await api("GET", "/api/dorks?archived=true")).json.some((d) => d.id === id));
  check("delete", (await api("DELETE", `/api/dorks/${id}`)).status === 200);
  await until(async () => (await api("GET", `/api/dorks/${id}`)).status === 404, "the deleted dork disappears");
  check("the deleted dork is gone from every list", !(await api("GET", "/api/dorks?archived=true")).json.some((d) => d.id === id) && !(await api("GET", "/api/dorks")).json.some((d) => d.id === id));

  // ---- secrets never reach disk in the clear or the logs
  const needles = [CLAUDE, GITHUB, CLI_SECRET];
  const files = readdirSync(dataDir).filter((f) => f.startsWith("dorks.db"));
  let leaked = [];
  for (const f of files) for (const n of needles) if (readFileSync(join(dataDir, f)).includes(Buffer.from(n))) leaked.push(`${f}:${n.slice(0, 8)}`);
  for (const n of needles) if (logs.join("").includes(n)) leaked.push(`logs:${n.slice(0, 8)}`);
  check("no token or CLI secret is in the database files or the logs in the clear", leaked.length === 0, leaked.join(" "));

  // ---- supervision: a server whose supervisor dies shuts itself down (DORKS_PARENT_PID, set by the desktop shell)
  const supervisor = spawn("sleep", ["300"], { stdio: "ignore" });
  const orphan = spawn(cmd, args, { env: { ...env, DORKS_DATA_DIR: mkdtempSync(join(tmpdir(), "dorks-e2e-parent-")), DORKS_PARENT_PID: String(supervisor.pid) }, stdio: "ignore" });
  const orphanExit = new Promise((resolve) => orphan.on("exit", () => resolve(true)));
  await sleep(2500);
  check("a server with a live supervisor keeps running", orphan.exitCode === null);
  supervisor.kill("SIGKILL");
  const exited = await Promise.race([orphanExit, sleep(10_000).then(() => false)]);
  check("a server exits by itself when its supervisor disappears", exited === true);
  if (!exited) orphan.kill("SIGKILL");
} catch (e) {
  console.error("e2e error:", e.message);
  if (lastDork) {
    const d = await api("GET", `/api/dorks/${lastDork}`).catch(() => null);
    const ev = await api("GET", `/api/dorks/${lastDork}/events?limit=12`).catch(() => null);
    console.error("dork:", JSON.stringify(d?.json), "\nlast events:", (ev?.json?.events ?? []).reverse().map((x) => `${x.seq}:${x.type}${x.state ? `(${x.state})` : ""}${x.message ? `[${x.message}]` : ""}`).join(" "));
  }
  console.error(logs.join("").split("\n").slice(process.env.E2E_VERBOSE ? 0 : -40).join("\n"));
  failed++;
} finally {
  cleanup();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
