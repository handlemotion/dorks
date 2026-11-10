import { BUILD_SANDBOX_LIFETIME_SECONDS, type SnapshotDriver } from "../core/snapshot";
import { BOX_ID, BoatError, createBoatCall, READY, type BoatOptions } from "./boat";

// Boat API calls the base-snapshot build needs. Sources (https://docs.boat.dev):
//   POST /sandboxes, GET /sandboxes, GET|DELETE /sandboxes/{id}      api/reference/sandboxes/*
//   PUT /sandboxes/{id}/files (UTF-8 or base64, 5 MiB)               api/reference/agent/write-sandbox-file
//   POST /sandboxes/{id}/commands (sync, 1-600 s)                    api/reference/agent/execute-sandbox-command
//   POST /saved-snapshots (202, then poll), GET /saved-snapshots/{name}   api/reference/snapshots/save-saved-snapshot, get-saved-snapshot

const POLL_MS = 2_000;
const READY_WAIT_MS = 240_000;
const COMMAND_SLACK_MS = 30_000;

type Sandbox = { id: string; state: string; labels?: Record<string, string>; dataExpiredAt?: string | null };

export interface BoatSnapshotOptions extends Pick<BoatOptions, "apiKey" | "org" | "fetch" | "sleep"> {}

export function boatSnapshotDriver(opts: BoatSnapshotOptions): SnapshotDriver {
  const call = createBoatCall(opts);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const path = (id: string, suffix = "") => {
    if (!BOX_ID.test(id)) throw new BoatError("boat: invalid sandbox id");
    return `/sandboxes/${id}${suffix}`;
  };
  const transient = (e: unknown) => e instanceof BoatError && (e.code === "idempotency_in_progress" || e.status === 500 || e.status === 502 || e.status === 503 || e.message.includes("network error"));

  async function getSandbox(id: string): Promise<Sandbox | null> {
    try {
      const json = await call("get", "GET", path(id));
      if (!json?.sandbox?.id || typeof json.sandbox.state !== "string") throw new BoatError("boat get: invalid sandbox response");
      return json.sandbox;
    } catch (e) {
      if (e instanceof BoatError && e.status === 404) return null;
      throw e;
    }
  }

  return {
    async listBuildSandboxes(label) {
      const found: { id: string }[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ label: `dorks-build=${label}`, limit: "200" });
        if (cursor) query.set("cursor", cursor);
        const json = await call("list", "GET", `/sandboxes?${query}`);
        if (!Array.isArray(json.sandboxes)) throw new BoatError("boat list: invalid response");
        for (const b of json.sandboxes as Sandbox[]) if (BOX_ID.test(b?.id) && b.labels?.["dorks-build"] === label && b.state !== "cancelled" && !b.dataExpiredAt) found.push({ id: b.id });
        cursor = json.pageInfo?.nextCursor || undefined;
      } while (cursor);
      return found;
    },

    async createBuildSandbox({ name, label, key }) {
      const body = { name, labels: { "dorks-build": label }, noEnv: true, ttlSeconds: BUILD_SANDBOX_LIFETIME_SECONDS };
      const deadline = Date.now() + READY_WAIT_MS;
      for (;;) {
        try {
          const created = await call("create build sandbox", "POST", "/sandboxes", body, { "Idempotency-Key": key });
          const id = created?.sandbox?.id;
          if (typeof id !== "string" || !BOX_ID.test(id)) throw new BoatError("boat create: response had no usable sandbox id");
          return { id };
        } catch (e) {
          if (!transient(e) || Date.now() >= deadline) throw e;
          await sleep(POLL_MS);
        }
      }
    },

    async waitReady(id) {
      const deadline = Date.now() + READY_WAIT_MS;
      for (;;) {
        const sandbox = await getSandbox(id);
        if (!sandbox || sandbox.state === "cancelled" || sandbox.dataExpiredAt) throw new BoatError("boat: the build sandbox disappeared");
        if (READY.has(sandbox.state)) return;
        if (sandbox.state === "error") throw new BoatError("boat: the build sandbox entered an error state");
        if (Date.now() >= deadline) throw new BoatError("boat: the build sandbox did not become ready in time");
        await sleep(POLL_MS);
      }
    },

    async writeFile(id, filePath, content, encoding) {
      await call("write file", "PUT", path(id, "/files"), { path: filePath, content, encoding }, {}, 120_000);
    },

    async run(id, command, timeoutSeconds) {
      const json = await call("run command", "POST", path(id, "/commands"), { command, timeoutSeconds }, {}, timeoutSeconds * 1000 + COMMAND_SLACK_MS);
      return {
        exitCode: typeof json.exitCode === "number" ? json.exitCode : null,
        stdout: typeof json.stdout === "string" ? json.stdout : "",
        stderr: typeof json.stderr === "string" ? json.stderr : "",
        timedOut: json.timedOut === true,
      };
    },

    async saveSnapshot(id, name) {
      try {
        await call("save snapshot", "POST", "/saved-snapshots", { sandboxId: id, name });
      } catch (e) {
        // A save under this name is already running (for example this build was resumed after a crash): the poll handles it.
        if (!(e instanceof BoatError && e.status === 409 && e.code === "save_in_progress")) throw e;
      }
    },

    async getSnapshot(name) {
      try {
        const json = await call("get snapshot", "GET", `/saved-snapshots/${encodeURIComponent(name)}`);
        const s = json?.snapshot;
        if (!s || (s.status !== "saving" && s.status !== "ready" && s.status !== "failed")) throw new BoatError("boat get snapshot: invalid response");
        return {
          name: String(s.name ?? name),
          status: s.status,
          error: typeof s.error === "string" ? s.error : undefined,
          sourceSandboxId: typeof s.sourceSandboxId === "string" ? s.sourceSandboxId : undefined,
        };
      } catch (e) {
        if (e instanceof BoatError && e.status === 404) return null;
        throw e;
      }
    },

    async deleteSandbox(id) {
      try {
        await call("delete", "DELETE", path(id), undefined, { "X-Ascii-Confirm-Delete": id });
      } catch (e) {
        if (!(e instanceof BoatError) || e.status !== 404) throw e;
      }
    },
  };
}

/** What a failed Boat call means for the person watching the build. Never includes response bodies. */
export function boatBuildFailureMessage(e: unknown): string {
  if (e instanceof BoatError) {
    // Codes from https://docs.boat.dev/api/v1 ("Error model"), /free-trial and /api-keys/scopes.
    if (e.code === "trial_saved_snapshots_not_allowed") return "Boat's free trial cannot save snapshots. End the trial in Boat, then retry.";
    if (e.code === "api_key_action_forbidden") return "The Boat API key lacks an action the build needs (create, run commands, write files, save snapshots, delete). Give the key those actions, then retry.";
    if (e.status === 401 || e.status === 403) return "Boat rejected the API key. Check the key and its access.";
    if (e.status === 402) return "Boat needs money in the wallet to save another snapshot (saved snapshots above your plan's included count cost $0.056 a day). Add funds in Boat, then retry.";
    if (e.status === 429) return "Boat is rate limiting this account. Wait a minute and retry.";
    return `${e.message}${e.code ? ` (${e.code})` : ""}`.slice(0, 200);
  }
  return "The snapshot build failed.";
}
