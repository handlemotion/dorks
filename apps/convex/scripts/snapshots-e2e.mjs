// End-to-end acceptance for customer sandbox environments (docs/snapshots.md) against a REAL Upstash Box account: no sandbox mocks, run the
// way production works under BYOK ("bring your own key"): the user pastes their own Upstash key, and everything (their base snapshot, their
// images, their dorks' boxes) is created through that key in their own account.
// A local Convex backend (scripts/dev-backend.sh) runs the product code; every box and snapshot below is a real Upstash resource,
// created by the product's own functions (workstation.provision, snapshots.put -> build steps, dorks.create -> boxes.create) and deleted at the end.
//
//   cd apps/convex && doppler run -p dorks -c dev -- node scripts/snapshots-e2e.mjs
//
//   needs: the local backend running (CONVEX_URL, CONVEX_SITE_URL default to 127.0.0.1:3210/3211), UPSTASH_BOX_API_KEY from Doppler dev (used
//          here as "the user's key"), pnpm, network access to Upstash, GitHub (public repos) and npm. Cost: about a dozen short-lived boxes
//          (a few cents), all deleted at the end, with the snapshots they made. Only resources this run created are deleted (the Upstash
//          account of Doppler dev is shared with other test runs).
//
// It publishes the current bridge bundle and switches the deployment to BOX_PROVIDER=upstash for the run, then puts the previous values back.
import { spawnSync } from "node:child_process";
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { codeFor, inbox, startMockResend } from "./mock-resend.mjs";

const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const KEY = process.env.UPSTASH_BOX_API_KEY;
const UP = process.env.UPSTASH_BOX_BASE_URL ?? "https://us-east-1.box.upstash.com";
if (!KEY) throw new Error("UPSTASH_BOX_API_KEY is not set (run under `doppler run -p dorks -c dev --`)");
const ORIGIN = "http://localhost:3000";
const RUN = Date.now().toString(36);
const REPO = "octocat/Hello-World"; // small and public: the clone needs no GitHub App
const OTHER_REPO = "octocat/Spoon-Knife";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, what, ms = 60_000, every = 1000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(every); } };
const code = (p) => p.then(() => null, (e) => e?.data?.code ?? e?.data?.[0]?.code ?? String(e?.message ?? e).slice(0, 80));

// ---- Upstash (direct, only to inspect and clean up: the product code does the real work)
const up = async (method, path, body) => {
  const r = await fetch(UP + path, { method, headers: { "X-Box-Api-Key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
};
const snapshots = async () => { const j = (await up("GET", "/v2/box/snapshots")).json; return Array.isArray(j) ? j : j?.snapshots ?? []; };
const boxes = async () => { const j = (await up("GET", "/v2/box")).json; return Array.isArray(j) ? j : j?.boxes ?? []; };
const exec = async (boxId, cmd) => { const r = (await up("POST", `/v2/box/${boxId}/exec`, { command: ["bash", "-c", cmd] })).json; return { code: r.exit_code, out: `${r.output ?? ""}${r.error ?? ""}` }; };

// ---- Convex deployment env (values go over stdin, never argv)
const envSet = (name, value) => { const r = spawnSync("npx", ["convex", "env", "set", name], { input: value, encoding: "utf8" }); if (r.status !== 0) throw new Error(`convex env set ${name} failed`); };
const envGet = (name) => { const r = spawnSync("npx", ["convex", "env", "get", name], { encoding: "utf8" }); return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null; };
const envRemove = (name) => spawnSync("npx", ["convex", "env", "remove", name], { encoding: "utf8" });
const envPut = (name, value) => (value === null ? envRemove(name) : envSet(name, value));

await startMockResend();
const post = (p, body) => fetch(CONVEX_SITE_URL + p, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
async function signIn(email) {
  await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  const c = await waitFor(() => codeFor(email), "otp mail", 15_000, 100);
  const r = await post("/api/auth/sign-in/email-otp", { email, otp: c });
  if (r.status !== 200) throw new Error(`sign-in ${r.status}`);
  const cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
  const tok = async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: ORIGIN } })).json()).token;
  const client = new ConvexClient(CONVEX_URL);
  client.setAuth(tok);
  return client;
}

// Values to put back. A run that died halfway leaves BOX_PROVIDER=upstash behind; then the real "before" is the sim setup of dev-backend.sh.
const leftover = envGet("BOX_PROVIDER") === "upstash";
const before = leftover ? { provider: "sim", grace: null } : { provider: envGet("BOX_PROVIDER"), grace: envGet("SNAPSHOT_SUPERSEDED_GRACE_SECONDS") };
const startedAt = Math.floor(Date.now() / 1000);
const dorkIds = [];
const baseIds = []; // the user's base snapshots this run made (deleted at the end)
let A;
try {
  // ---- the platform publishes its bridge bundle once; each user's own base snapshot is built from it (convex/workstation.ts)
  const pub = spawnSync("node", ["scripts/publish-bridge.mjs"], { encoding: "utf8" });
  if (pub.status !== 0) throw new Error(`publish-bridge failed: ${(pub.stderr || pub.stdout).slice(0, 300)}`);
  console.log(pub.stdout.trim());

  // ---- onboarding runs under the sim provider (the GitHub link callback has a sim mode); then the deployment switches to the real one
  envSet("BOX_PROVIDER", "sim");
  A = await signIn(`snap-${RUN}@dorks.build`);
  const B = await signIn(`snapother-${RUN}@dorks.build`);
  await A.mutation(api.settings.setClaudeToken, { token: "sk-ant-oat01-snapshots-e2e" });
  await A.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });
  envSet("BOX_PROVIDER", "upstash");
  envSet("SNAPSHOT_SUPERSEDED_GRACE_SECONDS", "20");

  // ---- BYOK: nothing works without the user's key; a wrong key is refused; theirs gets its own base built in their account
  check("without a key a user cannot create a dork", (await code(A.mutation(api.dorks.create, { repo: REPO, message: "x" }))) === "onboarding_incomplete");
  check("Upstash refuses a wrong key (checked against the real API)", (await code(A.action(api.settings.setUpstashKey, { key: `ubk_not_a_real_key_${RUN}` }))) === "invalid");
  await A.action(api.settings.setUpstashKey, { key: KEY });
  const ob0 = await A.query(api.settings.onboarding, {});
  check("onboarding shows the key is set, and never returns it", ob0.upstashKey === true && !JSON.stringify(ob0).includes(KEY));
  check("with a key but no base of their own yet, a dork cannot be created and an image cannot be built",
    (await code(A.mutation(api.dorks.create, { repo: REPO, message: "x" }))) === "onboarding_incomplete" && (await code(A.mutation(api.snapshots.put, { repo: REPO, setupScript: "true", build: true }))) === "not_configured");
  check("...and nothing would start from someone else's base", (await A.query(api.snapshots.effective, { repo: OTHER_REPO })).source === "none");
  const t0 = Date.now();
  const prov1 = await A.action(api.workstation.provision, {});
  baseIds.push(prov1.snapshotId);
  const baseSnap1 = (await snapshots()).find((s) => s.id === prov1.snapshotId);
  check("the user's own base snapshot was built in their account", (await A.query(api.settings.onboarding, {})).workstation === "ready" && baseSnap1?.status === "ready", `${prov1.snapshotId} in ${Math.round((Date.now() - t0) / 1000)}s`);
  check("a dork of any repo now starts from the user's own base", (await A.query(api.snapshots.effective, { repo: OTHER_REPO })).source === "account");
  check("no build box of the base was left behind", !(await boxes()).some((b) => b.name?.startsWith("dorks-base-build-") && b.status !== "deleted" && b.created_at >= startedAt - 5));

  const imageView = async (id) => (await A.query(api.snapshots.list, {})).find((i) => i.id === id);
  {
  // ---- validation and ownership
  check("empty script refused", (await code(A.mutation(api.snapshots.put, { repo: REPO, setupScript: "  \n", build: false }))) === "invalid");
  check("script over 16 KB refused", (await code(A.mutation(api.snapshots.put, { repo: REPO, setupScript: "x".repeat(16 * 1024 + 1), build: false }))) === "invalid");
  for (const repo of ["./x", "o/..", "no-slash", "a b/c", "*"]) check(`repo refused: ${repo}`, (await code(A.mutation(api.snapshots.put, { repo, setupScript: "true", build: false }))) === "invalid");
  check("no image yet: a new dork would start from the base snapshot", (await A.query(api.snapshots.effective, { repo: REPO })).source === "account");

  // ---- 1. configure + build: clone the repo, install a package, leave a marker
  const SCRIPT1 = `set -x
echo "node $(node --version) in $(pwd)"
npm install --no-audit --no-fund --silent is-odd@3.0.1
echo "baked-by-dorks-e2e-${RUN}" > .dorks-setup-marker
git log --oneline -1
`;
  const put1 = await A.mutation(api.snapshots.put, { repo: REPO, setupScript: SCRIPT1, timeoutMinutes: 10 });
  check("put returns an image and starts a build", !!put1.imageId && !!put1.buildId);
  check("the image keeps the repo as typed (GitHub's casing)", (await imageView(put1.imageId))?.repo === REPO);
  check("another account sees none of it", (await B.query(api.snapshots.list, {})).length === 0 && (await code(B.mutation(api.snapshots.rebuild, { imageId: put1.imageId }))) === "not_found" && (await code(B.mutation(api.snapshots.remove, { imageId: put1.imageId }))) === "not_found");
  check("saving the same script again while it builds joins that build", (await A.mutation(api.snapshots.put, { repo: REPO, setupScript: SCRIPT1, timeoutMinutes: 10 })).buildId === put1.buildId);
  let lastStep = "";
  const ready1 = await waitFor(async () => {
    const v = await imageView(put1.imageId);
    if (v.lastBuild && v.lastBuild.step !== lastStep) { lastStep = v.lastBuild.step; console.log(`  build step: ${lastStep} (${v.lastBuild.status})`); }
    if (v.status === "failed") throw new Error(`build failed: ${v.lastBuild.error}\n${v.lastBuild.log}`);
    return v.status === "ready" ? v : null;
  }, "first image build", 15 * 60_000, 3000);
  check("build succeeded", ready1.lastBuild.status === "succeeded" && ready1.outdated === null);
  check("build log shows the clone and the script output", /cloning octocat\/hello-world/i.test(ready1.lastBuild.log) && /is-odd|node v/.test(ready1.lastBuild.log) && /setup script exited with 0/.test(ready1.lastBuild.log), ready1.lastBuild.log.split("\n").slice(-3).join(" | "));
  check("new dorks of that repo (any casing) now use the image, other repos still the base (an image never serves another repo)", (await A.query(api.snapshots.effective, { repo: "Octocat/Hello-World" })).source === "repo" && (await A.query(api.snapshots.effective, { repo: OTHER_REPO })).source === "account");

  // ---- what the provider holds now: one ready snapshot named for the build, and the build box is gone
  const snap1 = (await snapshots()).filter((s) => s.name === `dorks-env-${ready1.lastBuild.id}`);
  check("exactly one ready snapshot exists for the build", snap1.length === 1 && snap1[0].status === "ready");
  check("the build box was deleted", await waitFor(async () => !(await boxes()).some((b) => b.name === `dorks-build-${ready1.lastBuild.id}`), "build box deleted", 60_000));

  // ---- 2. boot an agent sandbox from the image: the product's own create path (dorks.create -> boxes.create -> from-snapshot with init command + env)
  const dorkA = await A.mutation(api.dorks.create, { repo: REPO.toLowerCase(), message: "e2e: boot from the image" });
  dorkIds.push(dorkA);
  check("a dork typed in another casing is stored with the image's, so it finds the baked clone", (await A.query(api.dorks.get, { dorkId: dorkA })).repo === REPO);
  const boxA = await waitFor(async () => (await A.query(api.dorks.get, { dorkId: dorkA }))?.boxId, "dork box created", 4 * 60_000, 2000);
  const infoA = (await boxes()).find((b) => b.id === boxA);
  check("a real Upstash box was created for the dork", !!infoA && infoA.name === dorkA, `${infoA?.status}`);
  await waitFor(async () => ["idle", "running"].includes((await boxes()).find((b) => b.id === boxA)?.status), "box running", 120_000, 2000);
  const repoDir = `$HOME/work/${REPO}`;
  const repoCheck = await exec(boxA, `cd ${repoDir} && git rev-parse --is-inside-work-tree && cat .dorks-setup-marker && ls node_modules | head -3 && git remote get-url origin`);
  check("the dork's box has the repo cloned with the script's changes and dependencies", repoCheck.code === 0 && repoCheck.out.includes(`baked-by-dorks-e2e-${RUN}`) && /is-odd/.test(repoCheck.out), repoCheck.out.replace(/\n/g, " | ").slice(0, 200));
  check("the clone's remote has no credentials", /^https:\/\/github\.com\/octocat\/Hello-World(\.git)?$/.test(repoCheck.out.trim().split("\n").pop()), repoCheck.out.trim().split("\n").pop());
  // Upstash itself writes a GitHub token into every box it starts (~/.git-credentials, ~/.config/gh/hosts.yml); those two are the platform's, not ours.
  const leaks = await exec(boxA, `grep -rIlE '(ghs|ghp|gho|ghu)_[A-Za-z0-9]{20,}|github_pat_|sk-ant-[A-Za-z0-9_-]{20,}' $HOME --exclude-dir=node_modules --exclude-dir=work 2>/dev/null | grep -vxF -e $HOME/.git-credentials -e $HOME/.config/gh/hosts.yml | head -3`);
  const leftovers = await exec(boxA, "ls /tmp/dorks-build 2>&1");
  check("the image holds no credentials of ours and no build leftovers", leaks.out.trim() === "" && /No such file/.test(leftovers.out), `${leaks.out.trim()} ${leftovers.out.trim()}`.slice(0, 200));
  const proc = await exec(boxA, `pgrep -af dorks-bridge | head -2; ls $HOME/.dorks-bridge 2>&1 | head -2`);
  check("the dork's init command started the bridge in the restored box", /dorks-bridge/.test(proc.out), proc.out.replace(/\n/g, " | ").slice(0, 160));
  const bridgeHome = await exec(boxA, `pid=$(pgrep -f 'dorks-bridge' | head -1); tr '\\0' '\\n' < /proc/$pid/environ | grep -E '^(HOME|DORK_ID)=' | sed 's/DORK_ID=.*/DORK_ID=set/'`);
  check("the bridge runs as the same user and HOME the image was built in", /HOME=\/home\/boxuser/.test(bridgeHome.out), bridgeHome.out.replace(/\n/g, " | "));

  // a dork for a repo without an image boots from the base snapshot: no marker
  const dorkB = await A.mutation(api.dorks.create, { repo: OTHER_REPO, message: "e2e: base fallback" });
  dorkIds.push(dorkB);
  const boxB = await waitFor(async () => (await A.query(api.dorks.get, { dorkId: dorkB }))?.boxId, "second dork box", 4 * 60_000, 2000);
  await waitFor(async () => ["idle", "running"].includes((await boxes()).find((b) => b.id === boxB)?.status), "second box running", 120_000, 2000);
  const baseCheck = await exec(boxB, `ls $HOME/work 2>&1 | head -3; ls $HOME/work/octocat 2>&1 | head -3; command -v dorks-bridge`);
  check("a repo without an image boots from the base snapshot (no baked repo)", !/Hello-World/.test(baseCheck.out) && /dorks-bridge/.test(baseCheck.out), baseCheck.out.replace(/\n/g, " | ").slice(0, 160));
  // The user's own base has what an agent needs, including the pieces the hand-built base of 2026-10-09 lacked: the `dorks` command and the gh wrapper.
  const tools = await exec(boxB, `claude --version 2>&1 | head -1; dorks --help >/dev/null 2>&1 && echo dorks-ok; readlink /usr/local/bin/gh; readlink /usr/local/bin/dorks; /usr/bin/gh --version | head -1; gh stack --help >/dev/null 2>&1 && echo stack-ok; ls -l /usr/local/bin/dorks-bridge | cut -c1-10`);
  check("the user's own base has Claude Code, the dorks command, the gh wrapper in front of the real gh, and gh stack", /Claude Code/.test(tools.out) && /dorks-ok/.test(tools.out) && tools.out.includes("dorks-bridge") && /gh version 2\.102\.0/.test(tools.out) && /stack-ok/.test(tools.out), tools.out.replace(/\n/g, " | ").slice(0, 220));
  const hasTokens = await exec(boxB, `grep -rIlE '(ghs|ghp|gho|ghu)_[A-Za-z0-9]{20,}|github_pat_|sk-ant-[A-Za-z0-9_-]{20,}' $HOME --exclude-dir=node_modules 2>/dev/null | grep -vxF -e $HOME/.git-credentials -e $HOME/.config/gh/hosts.yml | head -3`);
  check("the base holds no credentials of ours", hasTokens.out.trim() === "", hasTokens.out.trim());

  // ---- 3. change the script: the old image keeps serving until the new one is ready, then is replaced and its snapshot deleted
  const SCRIPT2 = SCRIPT1.replace("is-odd@3.0.1", "is-even@1.0.0").replace(`dorks-e2e-${RUN}`, `dorks-e2e-v2-${RUN}`);
  const put2 = await A.mutation(api.snapshots.put, { repo: REPO, setupScript: SCRIPT2, timeoutMinutes: 10 });
  check("editing the script starts a rebuild of the same image", put2.imageId === put1.imageId && !!put2.buildId && put2.buildId !== put1.buildId);
  const mid = await imageView(put1.imageId);
  check("while rebuilding the image is building yet the previous snapshot still serves new dorks", mid.status === "building" && (await A.query(api.snapshots.effective, { repo: REPO })).source === "repo");
  const ready2 = await waitFor(async () => { const v = await imageView(put1.imageId); if (v.status === "failed") throw new Error(`rebuild failed: ${v.lastBuild.error}`); return v.status === "ready" && v.lastBuild.id === put2.buildId ? v : null; }, "rebuild", 15 * 60_000, 3000);
  check("rebuild succeeded and the image is current", ready2.lastBuild.status === "succeeded" && ready2.outdated === null && ready2.builtAt > ready1.builtAt);
  check("the superseded snapshot is deleted after the grace period, the new one remains", await waitFor(async () => { const names = (await snapshots()).map((s) => s.name); return !names.includes(`dorks-env-${ready1.lastBuild.id}`) && names.includes(`dorks-env-${ready2.lastBuild.id}`); }, "old snapshot deleted", 3 * 60_000, 3000));

  // ---- 4. failures leave the working image alone
  const failed = async (script, label) => {
    const r = await A.mutation(api.snapshots.put, { repo: REPO, setupScript: script, timeoutMinutes: 5 });
    return waitFor(async () => { const v = await imageView(put1.imageId); return v.lastBuild?.id === r.buildId && v.lastBuild.status !== "running" ? v : null; }, label, 10 * 60_000, 3000);
  };
  const f1 = await failed("echo about to fail\nexit 3\n", "failing script");
  check("a failing script fails the build with its exit code and log", f1.lastBuild.status === "failed" && /exit code 3/.test(f1.lastBuild.error) && /about to fail/.test(f1.lastBuild.log), f1.lastBuild.error);
  check("...and the previous image keeps serving (status stays ready, outdated is flagged)", f1.status === "ready" && f1.outdated === "script_changed" && (await A.query(api.snapshots.effective, { repo: REPO })).source === "repo");
  const f2 = await failed(`printf 'token=%s\\n' "ghp_$(printf 'a%.0s' $(seq 36))" > "$HOME/.npmrc"\n`, "credential script");
  check("a script that leaves a credential on disk is refused before the snapshot", f2.lastBuild.status === "failed" && /credential/.test(f2.lastBuild.error) && !f2.lastBuild.error.includes("ghp_aaaa"), f2.lastBuild.error);
  const f3 = await failed(`sudo rm -f /usr/local/bin/dorks-bridge\n`, "broken toolchain script");
  check("a script that breaks the agent's toolchain is refused", f3.lastBuild.status === "failed" && /dorks-bridge/.test(f3.lastBuild.error), f3.lastBuild.error);
  check("the log is redacted of tokens", !f2.lastBuild.log.includes("ghp_aaaa"));
  check("failed builds leave no build boxes behind", await waitFor(async () => !(await boxes()).some((b) => b.name?.startsWith("dorks-build-")), "no build boxes", 90_000, 3000));
  check("failed builds leave no extra snapshots", (await snapshots()).filter((s) => s.name?.startsWith("dorks-env-") && s.created_at >= startedAt).length === 1);

  // ---- 5. cancel, delete
  const slow = await A.mutation(api.snapshots.put, { repo: REPO, setupScript: "sleep 600\n", timeoutMinutes: 10 });
  await waitFor(async () => (await imageView(put1.imageId)).lastBuild.step === "wait", "slow build running", 4 * 60_000, 2000);
  await A.mutation(api.snapshots.cancel, { imageId: put1.imageId });
  const cancelled = await imageView(put1.imageId);
  check("cancel stops a running build", cancelled.lastBuild.id === slow.buildId && cancelled.lastBuild.status === "cancelled" && cancelled.status === "ready");
  check("...and its box is deleted", await waitFor(async () => !(await boxes()).some((b) => b.name?.startsWith("dorks-build-")), "cancelled build box deleted", 90_000, 3000));
  const liveSnap = (await snapshots()).find((s) => s.name === `dorks-env-${ready2.lastBuild.id}`);
  await A.mutation(api.snapshots.remove, { imageId: put1.imageId });
  check("deleting the image removes it", (await A.query(api.snapshots.list, {})).length === 0 && (await A.query(api.snapshots.effective, { repo: REPO })).source === "account");
  check("...and its snapshot", !!liveSnap && (await waitFor(async () => !(await snapshots()).some((s) => s.id === liveSnap.id), "snapshot deleted with the image", 3 * 60_000, 3000)));

  }

  // ---- 6. an image whose snapshot disappeared at the provider: new dorks fall back instead of failing
  const put3 = await A.mutation(api.snapshots.put, { repo: REPO, setupScript: "echo hi\n", timeoutMinutes: 5 });
  await waitFor(async () => (await imageView(put3.imageId)).status === "ready", "third image", 10 * 60_000, 3000);
  const victim = (await snapshots()).find((s) => s.name === `dorks-env-${put3.buildId}`);
  await up("DELETE", "/v2/box/snapshots", { ids: [victim.id] });
  const dorkC = await A.mutation(api.dorks.create, { repo: REPO, message: "e2e: image snapshot vanished" });
  dorkIds.push(dorkC);
  const boxC = await waitFor(async () => (await A.query(api.dorks.get, { dorkId: dorkC }))?.boxId, "fallback dork box", 4 * 60_000, 2000);
  check("a vanished image snapshot degrades to the base snapshot and the dork still gets a box", !!boxC && (await A.query(api.snapshots.effective, { repo: REPO })).source === "account" && (await imageView(put3.imageId)).status === "not_built");

  // ---- 7. the user's own base snapshot disappears at the provider: the dork says so, a rebuilt base brings it back, images built on the old one are flagged
  const put4 = await A.mutation(api.snapshots.rebuild, { imageId: put3.imageId });
  await waitFor(async () => { const v = await imageView(put3.imageId); if (v.status === "failed") throw new Error(`rebuild failed: ${v.lastBuild.error}`); return v.status === "ready" && v.lastBuild.id === put4.buildId; }, "image rebuilt on the current base", 10 * 60_000, 3000);
  check("the image is current on the user's base", (await imageView(put3.imageId)).outdated === null);
  await up("DELETE", "/v2/box/snapshots", { ids: [prov1.snapshotId] });
  const dorkD = await A.mutation(api.dorks.create, { repo: OTHER_REPO, message: "e2e: base vanished" });
  dorkIds.push(dorkD);
  await waitFor(async () => (await A.query(api.dorks.get, { dorkId: dorkD }))?.state === "error", "dork reports the missing base", 3 * 60_000, 2000);
  check("a vanished base fails the dork cleanly, with no box left behind", !(await A.query(api.dorks.get, { dorkId: dorkD })).boxId);
  const prov2 = await A.action(api.workstation.provision, {});
  baseIds.push(prov2.snapshotId);
  check("the user can build the base again", prov2.snapshotId !== prov1.snapshotId && (await snapshots()).find((x) => x.id === prov2.snapshotId)?.status === "ready");
  check("...and images built on the old base are flagged, yet keep serving", (await imageView(put3.imageId)).outdated === "base_changed" && (await A.query(api.snapshots.effective, { repo: REPO })).source === "repo");
  const dorkE = await A.mutation(api.dorks.create, { repo: OTHER_REPO, message: "e2e: after the base was rebuilt" });
  dorkIds.push(dorkE);
  const boxE = await waitFor(async () => (await A.query(api.dorks.get, { dorkId: dorkE }))?.boxId, "dork box from the rebuilt base", 4 * 60_000, 2000);
  check("...and with the rebuilt base a new dork gets its box", !!boxE);

  // ---- 8. variables are per repo: stored and listed with their scope, never with a value
  await A.mutation(api.settings.setCliSecret, { name: "E2E_SHARED", value: "wide" });
  await A.mutation(api.settings.setCliSecret, { name: "E2E_SHARED", value: "narrow", repo: REPO });
  await A.mutation(api.settings.setCliSecret, { name: "E2E_ONLY_OTHER", value: "x", repo: OTHER_REPO.toUpperCase() });
  const listed = await A.query(api.settings.secretList, {});
  check("variables are listed with their repo scope (normalized) and no values", JSON.stringify(listed) === JSON.stringify([{ name: "E2E_SHARED", repo: null }, { name: "E2E_ONLY_OTHER", repo: OTHER_REPO.toLowerCase() }, { name: "E2E_SHARED", repo: REPO.toLowerCase() }].sort((x, y) => (x.repo ?? "").localeCompare(y.repo ?? "") || x.name.localeCompare(y.name))) && !JSON.stringify(listed).includes("narrow"), JSON.stringify(listed));
  check("a bad repo scope is refused", (await code(A.mutation(api.settings.setCliSecret, { name: "E2E_X", value: "x", repo: "../etc" }))) === "invalid");
  await A.mutation(api.settings.removeCliSecret, { name: "E2E_SHARED", repo: REPO });
  await A.mutation(api.settings.removeCliSecret, { name: "E2E_SHARED" });
  await A.mutation(api.settings.removeCliSecret, { name: "E2E_ONLY_OTHER", repo: OTHER_REPO });
  check("removing them leaves nothing behind", (await A.query(api.settings.secretList, {})).length === 0);
} finally {
  // ---- cleanup: everything this run created (and only that: the Upstash account is shared), then the deployment env as it was
  try {
    for (const id of dorkIds) await A?.mutation(api.dorks.remove, { dorkId: id }).catch(() => {});
    await sleep(8000);
    for (const b of await boxes()) if (b.name?.startsWith("dorks-build-") || dorkIds.includes(b.name)) await up("DELETE", `/v2/box/${b.id}`);
    const stale = (await snapshots()).filter((s) => baseIds.includes(s.id) || (s.name?.startsWith("dorks-env-") && s.created_at >= startedAt - 5)).map((s) => s.id);
    if (stale.length) await up("DELETE", "/v2/box/snapshots", { ids: stale });
  } catch (e) { console.log("cleanup error", String(e).slice(0, 200)); }
  envPut("BOX_PROVIDER", before.provider);
  envPut("SNAPSHOT_SUPERSEDED_GRACE_SECONDS", before.grace);
}
const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
process.exit(failedChecks.length ? 1 : 0);
