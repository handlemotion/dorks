import { BoxNotFoundError, type BoxProvider, type DesktopOptions, type HostPortOptions } from "../core/box";

export const DEFAULT_BASE_URL = "https://boat.dev/api/v1";
export const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
export const READY = new Set(["ready", "idle", "running"]);
const POLL_MS = 2_000;
const WAIT_MS = 240_000;
/** How long a `provisioning` desktop (the first noVNC start) is waited for before the caller is told to retry. */
const DESKTOP_WAIT_MS = 30_000;
const DESKTOP_POLL_MS = 1_000;

type Sandbox = { id: string; state: string; labels?: Record<string, string>; dataExpiredAt?: string | null };

export type BoatOptions = {
  apiKey: string;
  scope: string;
  org?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export class BoatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BoatError";
  }
}

export type BoatCall = (op: string, method: string, path: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number) => Promise<any>;

/** One authenticated JSON call to the Boat API. Errors carry the HTTP status and Boat's error code, never the response body. */
export function createBoatCall(opts: Pick<BoatOptions, "apiKey" | "org" | "fetch">): BoatCall {
  const doFetch = opts.fetch ?? fetch;
  return async function call(op, method, path, body, headers = {}, timeoutMs = 30_000) {
    let res: Response;
    try {
      res = await doFetch(`${DEFAULT_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          ...(opts.org ? { "X-Boat-Org": opts.org } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BoatError(`boat ${op}: network error (${e instanceof Error ? e.name : "unknown"})`);
    }
    if (!res.ok) {
      const error: unknown = await res.json().catch(() => ({}));
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (res.status === 401 || res.status === 403) throw new BoatError(`boat ${op}: HTTP ${res.status}; check the Boat API key and its access`, res.status, code);
      throw new BoatError(`boat ${op}: HTTP ${res.status}`, res.status, code);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (json && typeof json === "object" && "ok" in json && json.ok === false) throw new BoatError(`boat ${op}: invalid success response`, res.status);
    return json;
  };
}

/**
 * Refuses a Boat environment that would hand a Codex sandbox more than the ChatGPT sign-in (docs/boat.md, "Signing in an agent").
 * On `/environments` only the `org` query selects the organization; the `X-Boat-Org` header does not apply there
 * (https://docs.boat.dev/api/reference/environments/list-sandbox-environments). Messages start with "boat: selected environment",
 * which the create job shows as is.
 */
export async function checkCodexEnvironment(call: BoatCall, org: string | undefined, name: string): Promise<void> {
  const environments = await call("list environments", "GET", `/environments${org ? `?org=${encodeURIComponent(org)}` : ""}`);
  const selected = environments?.environments?.find((item: { name?: string }) => item.name === name);
  if (!selected) throw new BoatError(`boat: selected environment "${name}" does not exist in this Boat account`);
  if (selected.safeForThirdParties !== false || selected.passAgentsCredentials !== true
    || selected.passGithub !== false || selected.passSecrets !== false || selected.passSandboxCredentials !== false
    || selected.proxyAiCredentials !== false || !selected.credentialProfileId || selected.credentialProfileId === "default")
    throw new BoatError("boat: selected environment must disable other credentials and use a named AI credential profile");
}

export function boatBox(opts: BoatOptions): BoxProvider {
  if (!opts.scope) throw new BoatError("boat: a scope is required");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const call = createBoatCall(opts);

  function path(id: string, suffix = ""): string {
    if (!BOX_ID.test(id)) throw new BoatError("boat: invalid sandbox id");
    return `/sandboxes/${id}${suffix}`;
  }

  async function get(id: string): Promise<Sandbox | null> {
    try {
      const json = await call("get", "GET", path(id));
      if (!json?.sandbox?.id || typeof json.sandbox.state !== "string") throw new BoatError("boat get: invalid sandbox response");
      return json.sandbox;
    } catch (e) {
      if (!(e instanceof BoatError) || e.status !== 404) throw e;
      return null;
    }
  }

  async function waitFor(id: string, states: Set<string>): Promise<Sandbox> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const sandbox = await get(id);
      if (!sandbox || sandbox.state === "cancelled" || sandbox.dataExpiredAt) throw new BoxNotFoundError("boat: sandbox no longer exists");
      if (states.has(sandbox.state)) return sandbox;
      if (sandbox.state === "error") throw new BoatError("boat: sandbox entered error state");
      if (Date.now() >= deadline) throw new BoatError(`boat: sandbox did not reach ${[...states].join("/")} in time`);
      await sleep(POLL_MS);
    }
  }

  async function labelFor(name: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${opts.scope}\n${name}`));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function list(label: string): Promise<Sandbox[]> {
    const found: Sandbox[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ label: `dorks=${label}`, limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const json = await call("list", "GET", `/sandboxes?${query}`);
      if (!Array.isArray(json.sandboxes)) throw new BoatError("boat list: invalid response");
      found.push(...json.sandboxes.filter((b: Sandbox) => BOX_ID.test(b?.id) && b.labels?.dorks === label));
      cursor = json.pageInfo?.nextCursor || undefined;
    } while (cursor);
    return found;
  }

  async function start(id: string): Promise<void> {
    const check = await call("check", "POST", path(id, "/commands"), { command: "command -v flock >/dev/null && command -v dorks-bridge >/dev/null" });
    if (check.exitCode !== 0) throw new BoatError("boat: base snapshot is missing flock or dorks-bridge");
    await call("start", "POST", path(id, "/commands"), { command: "flock -n /tmp/dorks-bridge.lock dorks-bridge", detached: true });
  }

  async function wake(id: string): Promise<void> {
    let sandbox = await get(id);
    if (!sandbox || sandbox.dataExpiredAt || sandbox.state === "cancelled") throw new BoxNotFoundError("boat: sandbox no longer exists");
    if (sandbox.state === "archiving") sandbox = await waitFor(id, new Set(["archived"]));
    if (sandbox.state === "archived" || sandbox.state === "error") {
      try {
        await call("resume", "POST", path(id, "/resume"), { ttlSeconds: null });
      } catch (e) {
        if (e instanceof BoatError && (e.code === "snapshot_data_expired" || e.status === 404)) {
          throw new BoxNotFoundError("boat: sandbox no longer exists");
        }
        throw e;
      }
    }
    await waitFor(id, READY);
    await start(id);
  }

  async function remove(id: string): Promise<void> {
    try {
      await call("delete", "DELETE", path(id), undefined, { "X-Ascii-Confirm-Delete": id });
    } catch (e) {
      if (!(e instanceof BoatError) || e.status !== 404) throw e;
    }
  }

  return {
    async createFromSnapshot(snapshotId, { name, initCommand, env, generation, boatEnvironment, machineType }) {
      if (initCommand !== "dorks-bridge") throw new BoatError("boat: unsupported bridge command");
      if (boatEnvironment) await checkCodexEnvironment(call, opts.org, boatEnvironment);
      const label = await labelFor(name);
      const existing = await list(label);
      const live = existing.find((b) => b.state !== "cancelled" && b.state !== "error" && !b.dataExpiredAt);
      if (live) {
        try {
          await wake(live.id);
          return { id: live.id };
        } catch (e) {
          if (!(e instanceof BoxNotFoundError)) throw e;
          await remove(live.id);
        }
      }
      for (const stale of existing.filter((b) => b.id !== live?.id && (b.state === "error" || b.dataExpiredAt))) await remove(stale.id);
      const body = {
        from: snapshotId, name, labels: { dorks: label }, env, ...(machineType ? { type: machineType } : {}),
        ...(boatEnvironment ? { environment: boatEnvironment, noEnv: false } : { noEnv: true }),
        ttlSeconds: null,
      };
      const key = `dorks-${label}-${generation ?? 0}`;
      const deadline = Date.now() + WAIT_MS;
      let created: any;
      for (;;) {
        try {
          created = await call("create", "POST", "/sandboxes", body, { "Idempotency-Key": key });
          break;
        } catch (e) {
          if (!(e instanceof BoatError) || !(e.code === "idempotency_in_progress" || e.status === 500 || e.status === 502 || e.status === 503 || e.message.includes("network error")) || Date.now() >= deadline) throw e;
          await sleep(POLL_MS);
        }
      }
      const id = created?.sandbox?.id;
      if (typeof id !== "string" || !BOX_ID.test(id)) throw new BoatError("boat create: response had no usable sandbox id");
      try {
        await waitFor(id, READY);
        await start(id);
        return { id };
      } catch (e) {
        try {
          await remove(id);
        } catch {
          console.error("boat create: could not clean up sandbox", id);
        }
        throw e;
      }
    },
    async resume(id) {
      await wake(id);
    },
    async pause(id) {
      const sandbox = await get(id);
      if (!sandbox || sandbox.state === "archived" || sandbox.state === "cancelled") return;
      if (sandbox.state !== "archiving") {
        try {
          await call("stop", "POST", path(id, "/stop"));
        } catch (e) {
          if (!(e instanceof BoatError) || e.status !== 404) throw e;
          return;
        }
      }
      await waitFor(id, new Set(["archived"]));
    },
    delete: remove,
    async desktopUrl(id, opts) {
      return desktopUrl(call, path(id, "/desktop"), opts, sleep);
    },
    async hostPort(id, port, hostOpts) {
      return hostPort(call, path(id, "/host"), port, hostOpts);
    },
  };
}

/**
 * Boat's live view (https://docs.boat.dev/api/reference/agent/get-desktop-streaming-url): `POST /desktop` streams the whole screen
 * over WebRTC. (Boat's `POST /browser` streams Chrome alone; not used: the desktop already shows Chrome, and a second viewer of it
 * takes the stream over.) A `provisioning` answer means the stream is still starting: ask again. The URL carries
 * its token in the `#fragment` and must be opened within 10 minutes, so it is minted per view and never kept. `overlay=0` hides
 * Boat's viewer chrome; it goes in the query, before the fragment.
 */
export async function desktopUrl(call: BoatCall, path: string, opts: DesktopOptions, sleep: (ms: number) => Promise<void>, waitMs = DESKTOP_WAIT_MS): Promise<string> {
  const op = "desktop";
  const deadline = Date.now() + waitMs;
  for (;;) {
    const json = await call(op, "POST", `${path}?${new URLSearchParams({ theme: opts.theme })}`);
    const url = json?.desktopUrl;
    if (typeof url === "string" && url.startsWith("https://")) return withOverlayOff(url);
    if (!json?.provisioning) throw new BoatError(`boat ${op}: response had no stream URL`);
    if (Date.now() >= deadline) throw new BoatError(`boat ${op}: the stream is still starting`, 503, "provisioning");
    await sleep(DESKTOP_POLL_MS);
  }
}

function withOverlayOff(url: string): string {
  const hash = url.indexOf("#");
  const [base, fragment] = hash < 0 ? [url, ""] : [url.slice(0, hash), url.slice(hash)];
  return `${base}${base.includes("?") ? "&" : "?"}overlay=0${fragment}`;
}

/**
 * Boat's hosted ports (https://docs.boat.dev/hosting): `POST /host` answers `https://<sub>-<port>.on.boat.dev`, the same URL on every
 * call. Hosted `public`: a protected URL gates the page with a `_port_auth` cookie, which is third-party inside the Previews tab's
 * iframe, and the desktop shell's WebKit blocks it (the frame stays blank). A proxy through the server would have to rewrite every
 * root-relative asset and HMR socket of an unknown dev server. The URL is only as private as the sandbox subdomain.
 */
export async function hostPort(call: BoatCall, path: string, port: number, opts: HostPortOptions): Promise<{ url: string }> {
  const json = await call("host", "POST", path, { port, public: true, ...(opts.title ? { title: opts.title } : {}), ...(opts.localhost ? { localhost: true } : {}) });
  const url = json?.url;
  if (typeof url !== "string" || !url.startsWith("https://")) throw new BoatError("boat host: response had no URL");
  // Never keep a token: if Boat ever answers a protected URL despite `public`, drop the query rather than store a credential.
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return { url: u.toString() };
}
