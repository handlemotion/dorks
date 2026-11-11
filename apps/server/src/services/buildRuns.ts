import { createHash } from "node:crypto";
import type { BuildSpec, RunKind, RunStatus, RunStep, RunView } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import type { SnapshotDriver } from "../core/snapshot";
import { insert, update } from "../db";
import { boatBuildFailureMessage } from "../lib/boatSnapshots";
import { instanceId } from "../lib/box";
import { hasTimer, setTimer } from "../lifecycle/dispatch";
import {
  baseKey, buildVarValues, dorkBuild, draftView, getBuild, hashSpec, imageName, ownBuild, secretValues, specOf, varsDigest, varsOf,
} from "./builds";
import { boatKey, githubToken, readSettings } from "./settings";

// A build run (docs/builds.md, "A run, step by step"): a sandbox from the base snapshot runs the build's setup; an `image` run then
// checks the disk for secrets and saves it as the build's snapshot, a `trial` run stops after the setup. Like the base-snapshot job
// (snapshot.ts): one `build:run:<id>` timer claimed at most once, every provider call idempotent, the sandbox deleted on every outcome,
// a crash re-queued as a new attempt. One run at a time across all builds (Boat's start limits are per account).
//
// Secrets: an image run of the approved spec gets the build-time variables; a trial gets only the plain ones. The GitHub token is used
// by the clone step and deleted before the setup script starts. Output is redacted before it is stored or shown.

export const RUN_JOB = "build:run:";
export const FORGET_JOB = "build:forget:";
const LOG_MAX = 256 * 1024;
const SETUP_CAP_MS = 30 * 60_000;
const SAVE_POLL_MS = 3_000;
const SAVE_POLLS = 400;
const FLUSH_MS = 500;
const WORK = "/home/user/work";
const TMP = "/tmp/dorks-build";
export const AGENT_TRIALS_PER_DAY = 10;
export const AGENT_IMAGES_PER_DAY = 5;
const DAY = 24 * 3600_000;

export interface RunRow {
  id: string;
  build_id: string;
  kind: RunKind;
  spec: string;
  spec_hash: string;
  started_by: string;
  status: RunStatus;
  step: RunStep | null;
  error: string | null;
  attempt: number;
  sandbox_id: string | null;
  process_id: number | null;
  command_id: string | null;
  exit_code: number | null;
  log: string;
  log_bytes: number;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export const runViewOf = (r: RunRow): RunView => ({
  id: r.id, buildId: r.build_id, kind: r.kind, status: r.status, step: r.step, startedBy: r.started_by, error: r.error, exitCode: r.exit_code,
  specHash: r.spec_hash, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, logBytes: r.log_bytes,
});

const getRun = (app: App, id: string) => app.db.get<RunRow>("SELECT * FROM build_runs WHERE id = ?", id);

/** Failures whose message is already written for the person (or agent) reading it. */
class RunError extends Error {}
class Superseded extends Error {}

// ---------------------------------------------------------------- starting and stopping
export interface StartOpts {
  kind: RunKind;
  /** `owner`, or `dork:<id>` (an agent, through its machine_* tools). */
  by: string;
  /** Agent trials run the dork's draft when it has one. */
  draftOf?: string;
}

/** Queues a run. Synchronous: one transaction. Throws `conflict` while this build has a run in progress. */
export function startRun(app: App, buildId: string, o: StartOpts): RunView {
  const s = readSettings(app);
  if (app.cfg.boxProvider === "boat" && !s.boatKeyEnc) fail("not_configured", "Add your Boat API key first.");
  if (!(s.baseSnapshotId ?? app.cfg.baseSnapshotId)) fail("not_configured", "Boat is still being prepared: wait for the base snapshot first.");
  return app.db.tx(() => {
    const b = ownBuild(app, buildId);
    if (app.db.get("SELECT 1 FROM build_runs WHERE build_id = ? AND status IN ('queued', 'running')", buildId)) fail("conflict", "This build is already running. Wait for it, or cancel it.");
    const vars = varsOf(app, buildId);
    let spec: BuildSpec = specOf(b, vars);
    const agent = o.by.startsWith("dork:");
    if (agent) {
      const since = app.now() - DAY;
      if (o.kind === "trial") {
        const n = app.db.get<{ n: number }>("SELECT count(*) AS n FROM build_runs WHERE started_by = ? AND kind = 'trial' AND created_at > ?", o.by, since)?.n ?? 0;
        if (n >= AGENT_TRIALS_PER_DAY) fail("limit", `You used ${AGENT_TRIALS_PER_DAY} trial runs today. Ask the owner to run more.`);
        const draft = o.draftOf ? draftView(app, buildId, o.draftOf) : null;
        if (draft && draft.status === "editing") spec = draft.spec;
      } else {
        // decision 7: an agent may only (re)build the spec the owner approved, never its draft.
        if (b.approvedHash !== b.specHash) fail("forbidden", "The build's current spec was not approved by the owner.");
        const n = app.db.get<{ n: number }>("SELECT count(*) AS n FROM build_runs WHERE build_id = ? AND kind = 'image' AND started_by LIKE 'dork:%' AND created_at > ?", buildId, since)?.n ?? 0;
        if (n >= AGENT_IMAGES_PER_DAY) fail("limit", `Agents started ${AGENT_IMAGES_PER_DAY} image builds of this machine today. Ask the owner.`);
      }
    }
    if (o.kind === "image") {
      const missing = vars.filter((v) => v.buildTime && !v.valueEnc).map((v) => v.name);
      if (missing.length) fail("not_configured", `Fill in ${missing.join(", ")} first: the setup script needs ${missing.length === 1 ? "it" : "them"}.`);
    }
    const id = app.uuid();
    insert(app.db, "build_runs", { id, buildId, kind: o.kind, spec, specHash: hashSpec(spec), startedBy: o.by, status: "queued", attempt: 1, log: "", logBytes: 0, createdAt: app.now() });
    setTimer(app, "", `${RUN_JOB}${id}`, 0, { attempt: 1 });
    touch(app, { t: "build", buildId });
    touch(app, { t: "builds" });
    return runViewOf(getRun(app, id)!);
  });
}

/** Stops a queued or running run; the job notices at its next step and deletes its sandbox. */
export function cancelRun(app: App, buildId: string, runId: string) {
  app.db.tx(() => {
    const r = getRun(app, runId);
    if (!r || r.build_id !== buildId) return fail("not_found", "This run no longer exists.");
    if (r.status !== "queued" && r.status !== "running") return;
    update(app.db, "build_runs", { id: runId }, { status: "cancelled", finishedAt: app.now(), error: "Cancelled." });
    touch(app, { t: "build", buildId });
    touch(app, { t: "builds" });
  });
}

/** After a restart: queued or running runs without a timer run again, as a new attempt (the next attempt deletes the old sandbox). */
export function recoverBuildRuns(app: App) {
  for (const r of app.db.all<RunRow>("SELECT * FROM build_runs WHERE status IN ('queued', 'running')")) {
    if (hasTimer(app, "", `${RUN_JOB}${r.id}`)) continue;
    app.db.tx(() => {
      update(app.db, "build_runs", { id: r.id }, { attempt: r.attempt + 1, status: "queued" });
      setTimer(app, "", `${RUN_JOB}${r.id}`, 0, { attempt: r.attempt + 1 });
    });
  }
}

/** The stored (redacted) log from a byte offset, for the UI and the agent's machine_logs. */
export function runLog(app: App, buildId: string, runId: string, after = 0): { text: string; next: number; done: boolean; run: RunView } {
  const r = getRun(app, runId);
  if (!r || r.build_id !== buildId) return fail("not_found", "This run no longer exists.");
  // `log` keeps the last LOG_MAX bytes of `log_bytes` written; an offset before that window starts at the window.
  const start = Math.max(0, r.log_bytes - Buffer.byteLength(r.log));
  const from = Math.max(after, start);
  const text = Buffer.from(r.log).subarray(from - start).toString("utf8");
  return { text, next: r.log_bytes, done: r.status !== "queued" && r.status !== "running", run: runViewOf(r) };
}

// ---------------------------------------------------------------- redaction
/** Replaces every known secret value, and its base64, with [redacted]. Values under 4 characters are not worth the false hits. */
export function redactor(values: string[]): (s: string) => string {
  const needles = [...new Set(values.filter((v) => v.length >= 4).flatMap((v) => [v, Buffer.from(v).toString("base64").replace(/=+$/, "")]))].sort((a, b) => b.length - a.length);
  if (!needles.length) return (s) => s;
  const re = new RegExp(needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (s) => s.replace(re, "[redacted]");
}

// ---------------------------------------------------------------- the job
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const runLabel = (app: App, buildId: string) => createHash("sha256").update(`build-run\n${instanceId(app)}\n${buildId}`).digest("hex");

function progress(app: App, runId: string, attempt: number, step: RunStep, patch: Record<string, unknown> = {}) {
  app.db.tx(() => {
    const r = getRun(app, runId);
    if (!r || r.status !== "running" || r.attempt !== attempt) throw new Superseded();
    update(app.db, "build_runs", { id: runId }, { step, ...patch });
    touch(app, { t: "build", buildId: r.build_id });
  });
}

const tail = (s: string, n = 6) => {
  const t = s.trim().split("\n").slice(-n).join("\n");
  return t.slice(-600);
};

export async function runBuildRun(app: App, runId: string, attempt: number): Promise<void> {
  const r0 = getRun(app, runId);
  if (!r0 || r0.attempt !== attempt || (r0.status !== "queued" && r0.status !== "running")) return;
  // One run at a time across builds: wait for the other one.
  const other = app.db.get<{ id: string }>("SELECT id FROM build_runs WHERE status = 'running' AND id != ?", runId);
  if (other) return app.db.tx(() => setTimer(app, "", `${RUN_JOB}${runId}`, 5_000, { attempt }));
  const build = getBuild(app, r0.build_id);
  if (!build) return;
  app.db.tx(() => {
    update(app.db, "build_runs", { id: runId }, { status: "running", step: "prepare", startedAt: app.now(), error: null });
    touch(app, { t: "build", buildId: build.id });
    touch(app, { t: "builds" });
  });

  const spec = JSON.parse(r0.spec) as BuildSpec;
  const isImage = r0.kind === "image";
  const label = runLabel(app, build.id);
  let driver: SnapshotDriver | undefined;
  let sandboxId: string | undefined;
  let processId: number | undefined;
  try {
    driver = await app.getSnapshotDriver();
    const base = readSettings(app).baseSnapshotId ?? app.cfg.baseSnapshotId;
    if (!base) throw new RunError("Boat is still being prepared: wait for the base snapshot, then retry.");
    const baseAt = baseKey(app);
    const gh = spec.repos.length ? ((await githubToken(app)) ?? (app.cfg.boxProvider === "sim" ? "sim-github-token" : undefined)) : undefined;
    if (spec.repos.length && !gh) throw new RunError("Add a GitHub token in Settings: the build clones repositories.");
    // An image run of the approved spec gets the build-time variables; anything else gets the plain ones only.
    const approved = isImage && build.approvedHash === r0.spec_hash;
    const allBuildTime = await buildVarValues(app, build.id, true);
    const secrets = new Set(varsOf(app, build.id).filter((v) => v.secret).map((v) => v.name));
    const env = Object.fromEntries(Object.entries(allBuildTime).filter(([k]) => spec.buildTimeVars.includes(k) && (approved || !secrets.has(k))));
    const varsAt = varsDigest(app, build.id, allBuildTime);
    const redact = redactor([...(await secretValues(app, build.id)), ...(gh && app.cfg.boxProvider !== "sim" ? [gh] : [])]);

    progress(app, runId, attempt, "prepare");
    const leftovers = new Set<string>(r0.sandbox_id ? [r0.sandbox_id] : []);
    for (const b of await driver.listBuildSandboxes(label, "dorks-run")) leftovers.add(b.id);
    for (const id of leftovers) await removeSandbox(app, driver, id);

    progress(app, runId, attempt, "create");
    sandboxId = (await driver.createBuildSandbox({ name: `dorks-build-${build.name}`.slice(0, 120), label, labelKey: "dorks-run", key: `dorks-run-${runId}-${attempt}`, from: base, type: spec.machineType })).id;
    progress(app, runId, attempt, "start", { sandboxId });
    await driver.waitReady(sandboxId);

    if (spec.repos.length) {
      progress(app, runId, attempt, "clone");
      // The token lives in a 0600 file read by a one-shot credential helper, and both are gone before the setup script runs.
      await driver.writeFile(sandboxId, `${TMP}/gh`, gh!, "utf8");
      await driver.writeFile(sandboxId, `${TMP}/cred`, `#!/bin/sh\n[ "$1" = get ] || exit 0\necho username=x-access-token\necho "password=$(cat ${TMP}/gh)"\n`, "utf8");
      try {
        for (const repo of spec.repos) {
          const dir = `${WORK}/${repo.repo}`;
          const cmd = `chmod 600 ${TMP}/gh && chmod 700 ${TMP}/cred && mkdir -p ${q(dir.slice(0, dir.lastIndexOf("/")))} && rm -rf ${q(dir)} && ` +
            `git -c credential.helper= -c credential.helper=${q(`${TMP}/cred`)} clone --quiet ${repo.branch ? `--branch ${q(repo.branch)} ` : ""}${q(`https://github.com/${repo.repo}.git`)} ${q(dir)}`;
          const res = await driver.run(sandboxId, cmd, 600);
          if (res.exitCode !== 0) throw new RunError(`Could not clone ${repo.repo}${res.timedOut ? " (it took more than 10 minutes)" : ""}. ${redact(tail(res.stderr || res.stdout, 3))}`.trim());
        }
      } finally {
        await driver.run(sandboxId, `rm -rf ${TMP}/gh ${TMP}/cred`, 60).catch(() => undefined);
      }
    }

    progress(app, runId, attempt, "setup");
    const parts = ["set -e", "cd /home/user"];
    if (Object.keys(env).length) {
      await driver.writeFile(sandboxId, `${TMP}/env`, Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join("\n") + "\n", "utf8");
      parts.push(`chmod 600 ${TMP}/env`, `set -a; . ${TMP}/env; set +a`, `rm -f ${TMP}/env`);
    }
    if (spec.setupScript.trim()) {
      await driver.writeFile(sandboxId, `${TMP}/setup.sh`, spec.setupScript, "utf8");
      parts.push(`echo "== setup script"`, `bash -e ${TMP}/setup.sh`);
    }
    spec.repos.forEach((repo, i) => {
      if (!repo.setupScript?.trim()) return;
      parts.push(`echo ${q(`== ${repo.repo}`)}`, `(cd ${q(`${WORK}/${repo.repo}`)} && bash -e ${TMP}/repo-${i}.sh)`);
    });
    for (const [i, repo] of spec.repos.entries()) if (repo.setupScript?.trim()) await driver.writeFile(sandboxId, `${TMP}/repo-${i}.sh`, repo.setupScript, "utf8");
    parts.push(`echo "== done"`);
    await driver.writeFile(sandboxId, `${TMP}/run`, parts.join("\n") + "\n", "utf8");
    const started = await driver.runDetached(sandboxId, `bash ${TMP}/run`);
    processId = started.processId;
    progress(app, runId, attempt, "setup", { processId, commandId: started.commandId ?? null });
    const exitCode = await follow(app, driver, runId, attempt, sandboxId, processId, redact);
    processId = undefined;
    if (exitCode !== 0) {
      const log = getRun(app, runId)?.log ?? "";
      throw new RunError(`The setup failed (exit ${exitCode ?? "unknown"}).\n${tail(log)}`.trim());
    }

    if (isImage) {
      progress(app, runId, attempt, "scan");
      const values = [...(await secretValues(app, build.id)), ...(gh && app.cfg.boxProvider !== "sim" ? [gh] : [])].filter((v) => v.length >= 4 && !v.includes("\n"));
      if (values.length) {
        await driver.writeFile(sandboxId, "/tmp/dorks-scan", values.join("\n") + "\n", "utf8");
        const scan = await driver.run(sandboxId, `chmod 600 /tmp/dorks-scan; hits=$(sudo grep -rlsF -f /tmp/dorks-scan /home /root /etc /usr/local /opt /var/lib 2>/dev/null | grep -v '^/tmp/' | head -5); rm -f /tmp/dorks-scan; printf '%s' "$hits"`, 600);
        const hits = scan.stdout.trim();
        if (hits) throw new RunError(`A secret value was found on the machine, so it was not saved: ${hits.split("\n").join(", ")}. Make the setup keep secrets out of files (pass them in the environment), then build again.`);
        if (scan.exitCode !== 0 && !scan.stdout) throw new RunError("The secret check could not run. Retry the build.");
      }
      await driver.run(sandboxId, `rm -rf ${TMP}`, 60).catch(() => undefined);

      progress(app, runId, attempt, "save");
      const name = imageName(app, build.id);
      await driver.saveSnapshot(sandboxId, name);
      await waitSaved(app, driver, name, sandboxId);

      progress(app, runId, attempt, "finish");
      const gone = app.db.tx(() => {
        const r = getRun(app, runId);
        if (!r || r.status !== "running" || r.attempt !== attempt) throw new Superseded();
        const now = app.now();
        if (!getBuild(app, build.id)) return true;
        update(app.db, "builds", { id: build.id }, { image: name, imageHash: r0.spec_hash, imageBase: baseAt, imageVars: varsAt, imageAt: now });
        update(app.db, "build_runs", { id: runId }, { status: "succeeded", step: null, finishedAt: now });
        touch(app, { t: "build", buildId: build.id });
        touch(app, { t: "builds" });
        return false;
      });
      if (gone) await driver.deleteSnapshot(name).catch(() => undefined); // the build was deleted while it saved
    } else {
      app.db.tx(() => {
        const r = getRun(app, runId);
        if (!r || r.status !== "running" || r.attempt !== attempt) throw new Superseded();
        update(app.db, "build_runs", { id: runId }, { status: "succeeded", step: null, finishedAt: app.now() });
        touch(app, { t: "build", buildId: build.id });
        touch(app, { t: "builds" });
      });
    }
    console.error(`build run ${r0.kind} succeeded`, build.id.slice(0, 8));
  } catch (e) {
    if (!(e instanceof Superseded)) {
      console.error(`build run ${r0.kind} failed`, e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "unknown");
      const message = e instanceof RunError ? e.message : boatBuildFailureMessage(e);
      app.db.tx(() => {
        const r = getRun(app, runId);
        if (!r || r.attempt !== attempt || r.status !== "running") return;
        update(app.db, "build_runs", { id: runId }, { status: "failed", error: message, finishedAt: app.now() });
        touch(app, { t: "build", buildId: r.build_id });
        touch(app, { t: "builds" });
      });
    }
  } finally {
    if (driver && sandboxId) {
      if (processId !== undefined) await driver.killCommand(sandboxId, processId).catch(() => undefined);
      await removeSandbox(app, driver, sandboxId);
    }
  }
}

/** Streams the setup's output into the run's log until it exits; enforces the time cap and notices a cancel. */
async function follow(app: App, driver: SnapshotDriver, runId: string, attempt: number, sandboxId: string, processId: number, redact: (s: string) => string): Promise<number | null> {
  let pending = "";
  let flushedAt = 0;
  const flush = (force = false) => {
    if (!pending || (!force && app.now() - flushedAt < FLUSH_MS)) return;
    // Only whole lines, unless forced: a secret split across two chunks must be redacted in one piece.
    const cut = force || pending.length > 64 * 1024 ? pending.length : pending.lastIndexOf("\n") + 1;
    if (!cut) return;
    const chunk = redact(pending.slice(0, cut));
    pending = pending.slice(cut);
    flushedAt = app.now();
    app.db.tx(() => {
      const r = getRun(app, runId);
      if (!r || r.status !== "running" || r.attempt !== attempt) throw new Superseded();
      let log = r.log + chunk;
      if (log.length > LOG_MAX) log = log.slice(log.length - LOG_MAX);
      update(app.db, "build_runs", { id: runId }, { log, logBytes: r.log_bytes + Buffer.byteLength(chunk) });
      touch(app, { t: "build", buildId: r.build_id });
    });
  };
  const deadline = app.now() + SETUP_CAP_MS;
  let offsets = { stdout: 0, stderr: 0 };
  for (;;) {
    if (app.now() > deadline) throw new RunError(`The setup did not finish in ${SETUP_CAP_MS / 60_000} minutes, so it was stopped.`);
    const res = await driver.attach(sandboxId, processId, offsets, (_s, data) => {
      pending += data;
      flush();
    });
    offsets = res.offsets;
    if (res.t === "exit") {
      flush(true);
      return res.exitCode;
    }
    flush(true);
    const r = getRun(app, runId);
    if (!r || r.status !== "running" || r.attempt !== attempt) throw new Superseded();
  }
}

async function waitSaved(app: App, driver: SnapshotDriver, name: string, sandboxId: string) {
  for (let i = 0; i < SAVE_POLLS; i++) {
    const info = await driver.getSnapshot(name);
    if (info?.sourceSandboxId === sandboxId) {
      if (info.status === "ready") return;
      if (info.status === "failed") throw new RunError(`Boat could not save the image: ${(info.error ?? "no reason given").slice(0, 200)}`);
    }
    await app.sleep(SAVE_POLL_MS);
  }
  throw new RunError("Boat took too long to save the image. Check Boat, then build again.");
}

async function removeSandbox(app: App, driver: SnapshotDriver, id: string) {
  try {
    await driver.deleteSandbox(id);
  } catch (e) {
    console.error("could not delete a build sandbox; retrying", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    app.db.tx(() => setTimer(app, "", `orphan:${id}`, 15_000, { boxId: id, attempt: 1 }));
  }
}

/** `build:forget:<image>`: a deleted build's saved snapshot. Retried with backoff; Boat answers a missing one as done. */
export async function forgetImage(app: App, image: string, attempt: number) {
  try {
    if (app.cfg.boxProvider === "boat" && !(await boatKey(app))) return;
    await (await app.getSnapshotDriver()).deleteSnapshot(image);
  } catch (e) {
    console.error("could not delete a build image; retrying", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    if (attempt < 6) app.db.tx(() => setTimer(app, "", `${FORGET_JOB}${image}`, 30_000 * 2 ** attempt, { image, attempt: attempt + 1 }));
  }
}

/** The agent's way in (machine_run): its own dork's build only. */
export function startRunForDork(app: App, dorkId: string, kind: RunKind): RunView {
  const b = dorkBuild(app, dorkId);
  if (!b) return fail("not_configured", "This session runs on the base machine, not on a build.");
  return startRun(app, b.id, { kind, by: `dork:${dorkId}`, draftOf: dorkId });
}
