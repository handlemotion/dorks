import { BoxNotFoundError, type BoxProvider } from "../../core/box";

// Upstash Box REST provider. Endpoints and bodies follow the official SDK (@upstash/box 0.7.9, github.com/upstash/box), because
// the REST reference is not published as docs; see docs/upstash-box.md for sources and the items still marked UNKNOWN.
//
// Error policy: messages carry the operation and HTTP status only. Response bodies of failed calls are dropped unread (a provider error can
// echo the request: env vars, bridge secret); "box gone" is decided from 404/410 plus a confirming status check, never from body text.
// The API key only ever lives in a header.

const DEFAULT_BASE_URL = "https://us-east-1.box.upstash.com";
const REQUEST_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 2_000;
const READY_MAX_MS = 240_000;
const RESUME_MAX_MS = 60_000;
const LABEL_MAX = 20; // provider limit: <=20 chars of [A-Za-z0-9._:-], <=5 labels
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type BoxStatus = "creating" | "idle" | "running" | "paused" | "error" | "deleted";
type BoxData = { id: string; name?: string; labels?: string[]; status: BoxStatus; created_at?: number };
export type NetworkPolicy = { mode: "allow-all" | "deny-all" } | { mode: "custom"; allowedDomains?: string[]; allowedCidrs?: string[]; deniedCidrs?: string[] };

export type UpstashOptions = {
  apiKey: string;
  baseUrl?: string;
  /** "init": pass `init_command` (the platform re-runs it on every container start, so resume restarts the bridge).
   *  "exec": fallback if init commands are refused on the plan: start it with an exec call after create/resume. */
  startMode?: "init" | "exec";
  /** Command exec mode runs on resume (create uses the `initCommand` it is given). Default "dorks-bridge". */
  startCommand?: string;
  networkPolicy?: NetworkPolicy;
  /** Namespaces the idempotency label (CONVEX_CLOUD_URL in production) so dev and prod on one Upstash account never adopt or delete each other's boxes. */
  labelScope: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class UpstashBoxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstashBoxError";
  }
}

/** Provider label used to find the box again after a crash. Names are display-only at Upstash; labels are filterable. */
export async function dorkLabel(scope: string, name: string): Promise<string> {
  // `dork:<convexId>` is 37 chars and the limit is 20, so use "d:" + 18 hex of SHA-256(scope, name) (72 bits: no practical collisions).
  // The scope is part of the hash, so changing it later orphans existing boxes: fix it before the first real deploy.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}\n${name}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `d:${hex.slice(0, LABEL_MAX - 2)}`;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Detached start with a pidfile guard so re-running it on an already-started box does not launch a second bridge.
 * The pidfile survives a pause but PIDs restart, so a live pid only counts if its cmdline still contains the command.
 */
export function execStartScript(command: string, dir = "/tmp"): string {
  const pid = `${dir}/dorks-start.pid`;
  return `p=$(cat ${pid} 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -qF -- ${shq(command)}; then exit 0; fi; nohup setsid sh -c ${shq(command)} >${dir}/dorks-start.log 2>&1 & echo $! > ${pid}`;
}

export function upstashBox(opts: UpstashOptions): BoxProvider {
  if (!opts.labelScope) throw new UpstashBoxError("upstash: labelScope is required (CONVEX_CLOUD_URL not set)");
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const startMode = opts.startMode ?? "init";

  /** One HTTP call. Returns parsed JSON (or {}), or throws UpstashBoxError / BoxNotFoundError with no response text in the message. */
  async function call(op: string, method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { "X-Box-Api-Key": opts.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new UpstashBoxError(`upstash ${op}: network error (${e instanceof Error ? e.name : "unknown"})`);
    }
    const text = await res.text().catch(() => "");
    if (res.ok || okStatuses.includes(res.status)) {
      try {
        return { status: res.status, json: text ? JSON.parse(text) : {} };
      } catch {
        throw new UpstashBoxError(`upstash ${op}: invalid JSON response`, res.status);
      }
    }
    if (res.status === 401 || res.status === 403) throw new UpstashBoxError(`upstash ${op}: unauthorized (HTTP ${res.status}); check UPSTASH_BOX_API_KEY`, res.status);
    // "Not found" is only trusted on 404/410: a 5xx or 400 whose body mentions it (gateway page, "image not found") is not a missing box.
    if (res.status === 404 || res.status === 410) throw new BoxNotFoundError(`upstash ${op}: box not found (HTTP ${res.status})`);
    if (res.status === 429) throw new UpstashBoxError(`upstash ${op}: rate limited (HTTP 429)`, 429);
    throw new UpstashBoxError(`upstash ${op}: HTTP ${res.status}`, res.status);
  }

  const boxPath = (id: string, suffix = "") => {
    if (!SAFE_ID.test(id)) throw new UpstashBoxError("upstash: invalid box id");
    return `/v2/box/${id}${suffix}`;
  };

  const getBox = async (op: string, id: string) => (await call(op, "GET", boxPath(id))).json as BoxData;

  async function waitReady(op: string, box: BoxData): Promise<BoxData> {
    let b = box;
    const deadline = now() + READY_MAX_MS; // wall clock: each poll can itself take up to REQUEST_TIMEOUT_MS
    while (b.status === "creating") {
      if (now() >= deadline) throw new UpstashBoxError(`upstash ${op}: box still creating after ${READY_MAX_MS / 1000}s`);
      await sleep(READY_POLL_MS);
      b = await getBox(op, b.id);
    }
    if (b.status === "error") throw new UpstashBoxError(`upstash ${op}: box entered error state`);
    return b;
  }

  /**
   * Box state with "gone" confirmed: null only if GET /v2/box/{id} is 404 *and* the API itself answers (a list call works).
   * A 404 from a mistyped base URL or a renamed route fails both, and is reported as a configuration error, not a missing box.
   */
  async function statusOf(op: string, id: string): Promise<BoxData | null> {
    try {
      return await getBox(op, id);
    } catch (e) {
      if (!(e instanceof BoxNotFoundError)) throw e;
    }
    try {
      await call(op, "GET", "/v2/box?label=dorks-probe");
    } catch {
      throw new UpstashBoxError(`upstash ${op}: 404 for the box and for the list endpoint; check UPSTASH_BOX_BASE_URL`);
    }
    return null;
  }

  async function listByLabel(label: string): Promise<BoxData[]> {
    const { json } = await call("list", "GET", `/v2/box?label=${encodeURIComponent(label)}`);
    const all: BoxData[] = Array.isArray(json) ? json : Array.isArray(json?.boxes) ? json.boxes : [];
    // Re-check client-side: never act on a box that merely came back from an over-broad filter.
    return all.filter((b) => b?.id && SAFE_ID.test(b.id) && b.status !== "deleted" && b.labels?.includes(label));
  }

  /** Oldest first, id as tiebreak, so two racing creators agree on the winner without coordination. */
  const oldestFirst = (a: BoxData, b: BoxData) => (a.created_at ?? 0) - (b.created_at ?? 0) || (a.id < b.id ? -1 : 1);

  async function remove(id: string) {
    try {
      await call("delete", "DELETE", boxPath(id));
    } catch (e) {
      if (!(e instanceof BoxNotFoundError)) throw e;
      if ((await statusOf("delete", id)) !== null) throw new UpstashBoxError("upstash delete: HTTP 404 but the box exists");
      // confirmed gone: success
    }
  }

  async function startViaExec(id: string, command: string) {
    if (startMode !== "exec") return;
    await call("start", "POST", boxPath(id, "/exec"), { command: ["sh", "-c", execStartScript(command)] });
  }

  async function resumeBox(id: string) {
    try {
      await call("resume", "POST", boxPath(id, "/resume"));
      return;
    } catch (e) {
      if (e instanceof UpstashBoxError && (e.status === 401 || e.status === 403 || e.status === 429)) throw e;
      // Resuming a running box may be refused rather than ignored (UNKNOWN which), and a 404 may not mean what it says:
      // the box's own state is the source of truth.
      const b = await statusOf("resume", id);
      if (!b || b.status === "deleted") throw new BoxNotFoundError("upstash resume: box not found");
      if (b.status === "running" || b.status === "idle") return;
      throw e instanceof BoxNotFoundError ? new UpstashBoxError("upstash resume: HTTP 404 but the box exists") : e;
    }
  }

  /** The SDK does not wait after resume, and an exec sent too early may reach a box that is not running yet. */
  async function waitRunning(id: string) {
    const deadline = now() + RESUME_MAX_MS;
    for (let b = await getBox("resume", id); b.status !== "running" && b.status !== "idle"; b = await getBox("resume", id)) {
      if (b.status === "deleted") throw new BoxNotFoundError("upstash resume: box not found");
      if (b.status === "error" || now() >= deadline) throw new UpstashBoxError(`upstash resume: box not running (status ${b.status})`);
      await sleep(READY_POLL_MS);
    }
  }

  async function resumeAndStart(id: string, command: string) {
    await resumeBox(id);
    if (startMode !== "exec") return;
    await waitRunning(id);
    await startViaExec(id, command);
  }

  return {
    async createFromSnapshot(snapshotId, { name, initCommand, env }) {
      const label = await dorkLabel(opts.labelScope, name);

      const existing = (await listByLabel(label)).sort(oldestFirst);
      const live = existing.find((b) => b.status !== "error");
      for (const dead of existing.filter((b) => b.status === "error")) await remove(dead.id);
      if (live) {
        const ready = await waitReady("create", live);
        // A retry after a crash: the box exists, but nothing else would wake it (paused) or start its bridge (exec mode, crash before start).
        if (ready.status === "paused") await resumeAndStart(ready.id, initCommand);
        else await startViaExec(ready.id, initCommand); // pidfile-guarded, so repeating it is safe
        return { id: ready.id };
      }

      const body: Record<string, unknown> = { snapshot_id: snapshotId, name, labels: [label], env_vars: env };
      if (startMode === "init") body.init_command = initCommand; // not inherited from the snapshot, so always pass it
      if (opts.networkPolicy) body.network_policy = serializePolicy(opts.networkPolicy);
      const created = (await call("create", "POST", "/v2/box/from-snapshot", body)).json as BoxData;
      if (!created?.id || !SAFE_ID.test(created.id)) throw new UpstashBoxError("upstash create: response had no usable box id");
      let mine: BoxData;
      try {
        mine = await waitReady("create", created);
      } catch (e) {
        await remove(created.id).catch(() => {}); // do not leak a half-made box; the retry creates a fresh one
        throw e;
      }

      // Two creators can both see an empty list. Converge: the oldest box wins, the other deletes itself.
      const all = (await listByLabel(label)).sort(oldestFirst);
      const winner = all[0];
      if (winner && winner.id !== mine.id && all.some((b) => b.id === mine.id)) {
        await remove(mine.id);
        return { id: winner.id };
      }
      await startViaExec(mine.id, initCommand);
      return { id: mine.id };
    },

    async resume(boxId) {
      await resumeAndStart(boxId, opts.startCommand ?? "dorks-bridge");
    },

    async pause(boxId) {
      try {
        await call("pause", "POST", boxPath(boxId, "/pause"));
      } catch (e) {
        if (e instanceof UpstashBoxError && (e.status === 401 || e.status === 403 || e.status === 429)) throw e;
        const b = await statusOf("pause", boxId);
        if (!b || b.status === "paused" || b.status === "deleted") return; // gone or already paused: nothing to do
        throw e instanceof BoxNotFoundError ? new UpstashBoxError("upstash pause: HTTP 404 but the box exists") : e;
      }
    },

    async delete(boxId) {
      await remove(boxId);
    },
  };
}

function serializePolicy(p: NetworkPolicy) {
  return p.mode === "custom" ? { mode: p.mode, allowed_domains: p.allowedDomains, allowed_cidrs: p.allowedCidrs, denied_cidrs: p.deniedCidrs } : { mode: p.mode };
}

/** Egress allow-list for a dork box (docs/upstash-box.md section e). Opt-in via UPSTASH_BOX_NETWORK_POLICY=dorks until verified on a real box. */
export const DORKS_NETWORK_POLICY: NetworkPolicy = {
  mode: "custom",
  allowedDomains: [
    "*.convex.cloud", // bridge: websocket + actions
    "github.com", "*.github.com", "*.githubusercontent.com", // git over https, API, raw/codeload
    "api.anthropic.com", "*.anthropic.com", // Claude Code
    "registry.npmjs.org", // npm install
  ],
};
