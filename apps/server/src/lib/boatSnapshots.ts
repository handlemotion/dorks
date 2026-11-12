import { Effect, Option, Schema } from "effect";
import { BUILD_SANDBOX_LIFETIME_SECONDS, type AttachResult, type SnapshotDriver } from "../core/snapshot";
import {
  BoatError,
  BOX_ID,
  boatFetch,
  createdId,
  decodeOr,
  deleteSandbox,
  getSandbox,
  ignoreStatus,
  isBoatStatus,
  isGone,
  isTransient,
  listSandboxes,
  makeBoatCall,
  optionalOn404,
  pauseWith,
  POLL_MS,
  pollUntil,
  READY,
  retryWhile,
  sandboxPath,
  type BoatOptions,
} from "./boatHttp";

// Boat API calls the base-snapshot build needs. Sources (https://docs.boat.dev):
//   POST /sandboxes, GET /sandboxes, GET|DELETE /sandboxes/{id}      api/reference/sandboxes/*
//   PUT /sandboxes/{id}/files (UTF-8 or base64, 5 MiB)               api/reference/agent/write-sandbox-file
//   POST /sandboxes/{id}/commands (sync, 1-600 s)                    api/reference/agent/execute-sandbox-command
//   POST /saved-snapshots (202, then poll), GET /saved-snapshots/{name}   api/reference/snapshots/save-saved-snapshot, get-saved-snapshot
//   DELETE /saved-snapshots/{name}                                   api/reference/snapshots/delete-saved-snapshot
//   POST /sandboxes/{id}/commands {detached}, GET .../commands/{pid}/stream, DELETE .../commands/{pid}   api/reference/agent/*

const READY_WAIT_MS = 240_000;
const COMMAND_SLACK_MS = 30_000;
const ATTACH_TIMEOUT_MS = 15 * 60_000;

export interface BoatSnapshotOptions extends Pick<BoatOptions, "apiKey" | "org" | "fetch" | "sleep"> {}

const CommandAnswer = Schema.Struct({
  exitCode: Schema.optional(Schema.Unknown),
  stdout: Schema.optional(Schema.Unknown),
  stderr: Schema.optional(Schema.Unknown),
  timedOut: Schema.optional(Schema.Unknown),
});
const DetachedAnswer = Schema.Struct({ processId: Schema.Number, commandId: Schema.optional(Schema.Unknown) });
const SnapshotAnswer = Schema.Struct({
  snapshot: Schema.Struct({
    name: Schema.optional(Schema.Unknown),
    status: Schema.Literals(["saving", "ready", "failed"]),
    error: Schema.optional(Schema.Unknown),
    sourceSandboxId: Schema.optional(Schema.Unknown),
  }),
});

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The Boat side of the base-snapshot and build-image builds (core/snapshot.ts). Each method runs an Effect at the Promise edge. */
export function boatSnapshotDriver(opts: BoatSnapshotOptions): SnapshotDriver {
  const call = makeBoatCall(opts);
  const pause = pauseWith(opts.sleep);
  const run = <A>(e: Effect.Effect<A, BoatError>) => Effect.runPromise(e);
  const commands = (id: string, suffix = "") => sandboxPath(id, `/commands${suffix}`);

  const waitReady = (id: string) =>
    pollUntil(
      getSandbox(call, id).pipe(
        Effect.flatMap((found) => {
          const s = Option.getOrUndefined(found);
          if (!s || isGone(s)) return Effect.fail(new BoatError("boat: the build sandbox disappeared"));
          if (READY.has(s.state)) return Effect.succeed(Option.some(undefined));
          return s.state === "error" ? Effect.fail(new BoatError("boat: the build sandbox entered an error state")) : Effect.succeed(Option.none<void>());
        }),
      ),
      { everyMs: POLL_MS, withinMs: READY_WAIT_MS, pause, onTimeout: () => new BoatError("boat: the build sandbox did not become ready in time") },
    );

  return {
    listBuildSandboxes: (label, labelKey = "dorks-build") => run(listSandboxes(call, labelKey, label).pipe(Effect.map((all) => all.filter((b) => !isGone(b)).map((b) => ({ id: b.id }))))),

    createBuildSandbox: ({ name, label, key, from, type, labelKey = "dorks-build" }) => {
      const body = { name, labels: { [labelKey]: label }, noEnv: true, ttlSeconds: BUILD_SANDBOX_LIFETIME_SECONDS, ...(from ? { from } : {}), ...(type ? { type } : {}) };
      const create = call("create build sandbox", "POST", "/sandboxes", { body, headers: { "Idempotency-Key": key } }).pipe(Effect.flatMap(createdId));
      return run(retryWhile(create, { retryable: isTransient, everyMs: POLL_MS, withinMs: READY_WAIT_MS, pause }).pipe(Effect.map((id) => ({ id }))));
    },

    waitReady: (id) => run(waitReady(id)),

    writeFile: (id, filePath, content, encoding) =>
      run(
        sandboxPath(id, "/files").pipe(
          Effect.flatMap((p) => call("write file", "PUT", p, { body: { path: filePath, content, encoding }, timeoutMs: 120_000 })),
          Effect.asVoid,
        ),
      ),

    run: (id, command, timeoutSeconds) =>
      run(
        commands(id).pipe(
          Effect.flatMap((p) => call("run command", "POST", p, { body: { command, timeoutSeconds }, timeoutMs: timeoutSeconds * 1000 + COMMAND_SLACK_MS })),
          Effect.flatMap(decodeOr(CommandAnswer, "boat run command: invalid response")),
          Effect.map((json) => ({
            exitCode: typeof json.exitCode === "number" ? json.exitCode : null,
            stdout: str(json.stdout) ?? "",
            stderr: str(json.stderr) ?? "",
            timedOut: json.timedOut === true,
          })),
        ),
      ),

    saveSnapshot: (id, name) =>
      run(
        call("save snapshot", "POST", "/saved-snapshots", { body: { sandboxId: id, name } }).pipe(
          Effect.asVoid,
          // A save under this name is already running (for example this build was resumed after a crash): the poll handles it.
          Effect.catchIf(
            (e) => isBoatStatus(e, 409) && e.code === "save_in_progress",
            () => Effect.void,
          ),
        ),
      ),

    getSnapshot: (name) =>
      run(
        call("get snapshot", "GET", `/saved-snapshots/${encodeURIComponent(name)}`).pipe(
          Effect.flatMap(decodeOr(SnapshotAnswer, "boat get snapshot: invalid response")),
          Effect.map(({ snapshot: s }) => ({ name: String(s.name ?? name), status: s.status, error: str(s.error), sourceSandboxId: str(s.sourceSandboxId) })),
          optionalOn404,
          Effect.map(Option.getOrNull),
        ),
      ),

    runDetached: (id, command) =>
      run(
        commands(id).pipe(
          Effect.flatMap((p) => call("start command", "POST", p, { body: { command, detached: true } })),
          Effect.flatMap(decodeOr(DetachedAnswer, "boat start command: response had no process id")),
          Effect.map((json) => ({ processId: json.processId, commandId: str(json.commandId) })),
        ),
      ),

    attach: (id, processId, offsets, onOutput) => run(attach(opts, id, processId, offsets, onOutput)),

    killCommand: (id, processId) =>
      run(
        commands(id, `/${processId}`).pipe(
          Effect.flatMap((p) => call("stop command", "DELETE", p)),
          ignoreStatus(404, 409),
        ),
      ),

    deleteSnapshot: (name) => run(call("delete snapshot", "DELETE", `/saved-snapshots/${encodeURIComponent(name)}`).pipe(ignoreStatus(404))),

    deleteSandbox: (id) => run(deleteSandbox(call, id)),
  };
}

type Offsets = { stdout: number; stderr: number };
type Frame = { type?: unknown; data?: unknown; nextOffset?: unknown; exitCode?: unknown; stdoutOffset?: unknown; stderrOffset?: unknown; error?: unknown };

const offsetsAfter = (f: Frame, at: Offsets): Offsets => ({
  stdout: typeof f.stdoutOffset === "number" ? f.stdoutOffset : at.stdout,
  stderr: typeof f.stderrOffset === "number" ? f.stderrOffset : at.stderr,
});

/** What one NDJSON frame of the attach stream means: output to pass on, the end of the stream, or nothing. */
function frameOutcome(f: Frame, at: Offsets, onOutput: (stream: "stdout" | "stderr", data: string) => void): AttachResult | BoatError | undefined {
  if ((f.type === "stdout" || f.type === "stderr") && typeof f.data === "string") {
    onOutput(f.type, f.data);
    if (typeof f.nextOffset === "number") at[f.type] = f.nextOffset;
    return undefined;
  }
  if (f.type === "exit") return { t: "exit", exitCode: typeof f.exitCode === "number" ? f.exitCode : null, offsets: offsetsAfter(f, at) };
  if (f.type === "reconnect") return { t: "reconnect", offsets: offsetsAfter(f, at) };
  if (f.type === "error") return new BoatError(`boat attach: ${str(f.error) ?? "stream error"}`, undefined, str(f.error));
  return undefined;
}

const parseFrame = (line: string): Frame | undefined => {
  try {
    const f: unknown = JSON.parse(line);
    return f && typeof f === "object" ? (f as Frame) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Follows a detached command's output. NDJSON: attached, stdout/stderr chunks (with nextOffset), heartbeat, then exit | reconnect |
 * error (api/reference/agent/attach-command). The stream ends itself after 10 minutes with a `reconnect` line. The reader is
 * released however this ends (an exit, an error, or the caller's fiber being interrupted).
 */
const attach = (opts: BoatSnapshotOptions, id: string, processId: number, offsets: Offsets, onOutput: (stream: "stdout" | "stderr", data: string) => void) =>
  Effect.gen(function* () {
    if (!BOX_ID.test(id)) return yield* new BoatError("boat: invalid sandbox id");
    const query = new URLSearchParams({ stdoutOffset: String(offsets.stdout), stderrOffset: String(offsets.stderr) });
    const res = yield* boatFetch(opts, "attach", `/sandboxes/${encodeURIComponent(id)}/commands/${processId}/stream?${query}`, { timeoutMs: ATTACH_TIMEOUT_MS });
    if (!res.body) return yield* new BoatError(`boat attach: HTTP ${res.status}`, res.status);
    const body = res.body;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => body.pipeThrough(new TextDecoderStream()).getReader()),
      (r) => Effect.promise(() => r.cancel().catch(() => {})),
    );
    const at = { ...offsets };
    let buf = "";
    for (;;) {
      const { value, done } = yield* Effect.promise(() => reader.read());
      if (done) return { t: "reconnect", offsets: at } satisfies AttachResult; // the connection dropped: open it again from where we are
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const frame = parseFrame(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
        const outcome = frame && frameOutcome(frame, at, onOutput);
        if (outcome instanceof BoatError) return yield* outcome;
        if (outcome) return outcome;
      }
    }
  }).pipe(Effect.scoped);

/** What a failed Boat call means for the person watching the build. Never includes response bodies. */
export function boatBuildFailureMessage(e: unknown): string {
  if (!(e instanceof BoatError)) return "The snapshot build failed.";
  // Codes from https://docs.boat.dev/api/v1 ("Error model"), /free-trial and /api-keys/scopes.
  const byCode: Record<string, string> = {
    trial_saved_snapshots_not_allowed: "Boat's free trial cannot save snapshots. End the trial in Boat, then retry.",
    api_key_action_forbidden: "The Boat API key lacks an action the build needs (create, run commands, write files, save snapshots, delete). Give the key those actions, then retry.",
  };
  if (e.code && Object.hasOwn(byCode, e.code)) return byCode[e.code];
  if (isBoatStatus(e, 401, 403)) return "Boat rejected the API key. Check the key and its access.";
  if (isBoatStatus(e, 402)) return "Boat needs money in the wallet to save another snapshot (saved snapshots above your plan's included count cost $0.056 a day). Add funds in Boat, then retry.";
  if (isBoatStatus(e, 429)) return "Boat is rate limiting this account. Wait a minute and retry.";
  return `${e.message}${e.code ? ` (${e.code})` : ""}`.slice(0, 200);
}
