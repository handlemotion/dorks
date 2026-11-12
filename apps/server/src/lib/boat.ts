import { Effect, Option, Schema } from "effect";
import { BoxNotFoundError, type BoxProvider, type DesktopOptions, type HostPortOptions } from "../core/box";
import {
  BoatError, BOX_ID, createdId, decodeOr, deleteSandbox, getSandbox, isBoatStatus, isGone, isTransient, listSandboxes, makeBoatCall,
  pauseWith, POLL_MS, pollUntil, READY, retryWhile, sandboxPath, type BoatCall, type BoatOptions, type Sandbox,
} from "./boatHttp";

export { BoatError, BOX_ID, createBoatCall, DEFAULT_BASE_URL, READY, type BoatCall, type BoatOptions } from "./boatHttp";

const WAIT_MS = 240_000;
/** How long a `provisioning` desktop (the first noVNC start) is waited for before the caller is told to retry. */
const DESKTOP_WAIT_MS = 30_000;
const DESKTOP_POLL_MS = 1_000;

type Pause = (ms: number) => Effect.Effect<void>;
type CreateOptions = Parameters<BoxProvider["createFromSnapshot"]>[1];

const notFound = () => new BoxNotFoundError("boat: sandbox no longer exists");

const Environments = Schema.Struct({
  environments: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
type Environment = Readonly<Record<string, unknown>>;

/** Only the dedicated ChatGPT profile reaches the box: no other credential, secret or AI proxy (docs/boat.md). */
const passesOnlyItsProfile = (e: Environment) =>
  e.safeForThirdParties === false && e.passAgentsCredentials === true && e.passGithub === false && e.passSecrets === false
  && e.passSandboxCredentials === false && e.proxyAiCredentials === false && !!e.credentialProfileId && e.credentialProfileId !== "default";

/**
 * Refuses a Boat environment that would hand a Codex sandbox more than the ChatGPT sign-in (docs/boat.md, "Signing in an agent").
 * On `/environments` only the `org` query selects the organization; the `X-Boat-Org` header does not apply there
 * (https://docs.boat.dev/api/reference/environments/list-sandbox-environments). Messages start with "boat: selected environment",
 * which the create job shows as is.
 */
export const checkCodexEnvironmentEffect = (call: BoatCall, org: string | undefined, name: string) =>
  Effect.gen(function* () {
    const json = yield* call("list environments", "GET", `/environments${org ? `?org=${encodeURIComponent(org)}` : ""}`);
    const { environments } = yield* decodeOr(Environments, "boat list environments: invalid response")(json);
    const selected = (environments ?? []).find((item) => item.name === name);
    if (!selected) return yield* new BoatError(`boat: selected environment "${name}" does not exist in this Boat account`);
    if (!passesOnlyItsProfile(selected)) return yield* new BoatError("boat: selected environment must disable other credentials and use a named AI credential profile");
  });

/** The Promise form, for the settings check (services/boatCheck.ts). */
export const checkCodexEnvironment = (call: (op: string, method: string, path: string) => Promise<any>, org: string | undefined, name: string): Promise<void> =>
  Effect.runPromise(checkCodexEnvironmentEffect((op, method, path) => Effect.tryPromise({ try: () => call(op, method, path), catch: asBoatError }), org, name));

const asBoatError = (e: unknown) => (e instanceof BoatError ? e : new BoatError(e instanceof Error ? e.message : "boat: request failed"));

/** The Boat sandbox provider (core/box.ts). Each method is an Effect run at the Promise edge the lifecycle expects. */
export function boatBox(opts: BoatOptions): BoxProvider {
  if (!opts.scope) throw new BoatError("boat: a scope is required");
  const call = makeBoatCall(opts);
  const pause = pauseWith(opts.sleep);
  const ops = boatOps(call, pause, opts);
  const run = <A>(e: Effect.Effect<A, BoatError | BoxNotFoundError>) => Effect.runPromise(e);
  return {
    createFromSnapshot: (snapshotId, o) => run(ops.create(snapshotId, o)),
    resume: (id) => run(ops.wake(id)),
    pause: (id) => run(ops.pause(id)),
    delete: (id) => run(deleteSandbox(call, id)),
    desktopUrl: (id, o) => run(sandboxPath(id, "/desktop").pipe(Effect.flatMap((p) => desktopUrl(call, p, o, pause)))),
    hostPort: (id, port, o) => run(sandboxPath(id, "/host").pipe(Effect.flatMap((p) => hostPort(call, p, port, o)))),
  };
}

function boatOps(call: BoatCall, pause: Pause, opts: BoatOptions) {
  /** Polls until the sandbox reaches one of `states`; a vanished sandbox is `BoxNotFoundError`. */
  const waitFor = (id: string, states: Set<string>) =>
    pollUntil(
      getSandbox(call, id).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.fail(notFound()),
          onSome: (s) => (isGone(s) ? Effect.fail(notFound()) : s.state === "error" ? Effect.fail(new BoatError("boat: sandbox entered error state")) : Effect.succeed(states.has(s.state) ? Option.some(s) : Option.none())),
        })),
      ),
      { everyMs: POLL_MS, withinMs: WAIT_MS, pause, onTimeout: () => new BoatError(`boat: sandbox did not reach ${[...states].join("/")} in time`) },
    );

  const labelFor = (name: string) =>
    Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${opts.scope}\n${name}`))).pipe(
      Effect.map((digest) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")),
    );

  /** Starts the bridge once; the `flock` keeps a second start (a resume racing a create) from running two. */
  const start = (id: string) =>
    Effect.gen(function* () {
      const commands = yield* sandboxPath(id, "/commands");
      const check = yield* call("check", "POST", commands, { body: { command: "command -v flock >/dev/null && command -v dorks-bridge >/dev/null" } });
      if (check?.exitCode !== 0) return yield* new BoatError("boat: base snapshot is missing flock or dorks-bridge");
      yield* call("start", "POST", commands, { body: { command: "flock -n /tmp/dorks-bridge.lock dorks-bridge", detached: true } });
    });

  const resumeArchived = (id: string) =>
    sandboxPath(id, "/resume").pipe(
      Effect.flatMap((p) => call("resume", "POST", p, { body: { ttlSeconds: null } })),
      Effect.catchIf((e) => e.code === "snapshot_data_expired" || isBoatStatus(e, 404), () => Effect.fail(notFound())),
    );

  const wake = (id: string) =>
    Effect.gen(function* () {
      let sandbox = Option.getOrUndefined(yield* getSandbox(call, id));
      if (!sandbox || isGone(sandbox)) return yield* Effect.fail(notFound());
      if (sandbox.state === "archiving") sandbox = yield* waitFor(id, new Set(["archived"]));
      if (sandbox.state === "archived" || sandbox.state === "error") yield* resumeArchived(id);
      yield* waitFor(id, READY);
      yield* start(id);
    });

  /** Adopts this name's live sandbox (a retried create after a lost response), replacing it if it turns out to be gone. */
  const adopt = (live: Sandbox) =>
    wake(live.id).pipe(
      Effect.as(Option.some({ id: live.id })),
      Effect.catchIf((e) => e instanceof BoxNotFoundError, () => deleteSandbox(call, live.id).pipe(Effect.as(Option.none()))),
    );

  /** Waits for a new sandbox and starts its bridge, deleting it on failure so it cannot bill indefinitely. */
  const bringUp = (id: string) =>
    waitFor(id, READY).pipe(
      Effect.andThen(start(id)),
      Effect.as({ id }),
      Effect.tapError(() => deleteSandbox(call, id).pipe(Effect.catch(() => Effect.sync(() => console.error("boat create: could not clean up sandbox", id))))),
    );

  const create = (snapshotId: string, { name, initCommand, env, generation, boatEnvironment, machineType }: CreateOptions) =>
    Effect.gen(function* () {
      if (initCommand !== "dorks-bridge") return yield* new BoatError("boat: unsupported bridge command");
      if (boatEnvironment) yield* checkCodexEnvironmentEffect(call, opts.org, boatEnvironment);
      const label = yield* labelFor(name);
      const existing = yield* listSandboxes(call, "dorks", label);
      const live = existing.find((b) => b.state !== "error" && !isGone(b));
      if (live) {
        const adopted = yield* adopt(live);
        if (Option.isSome(adopted)) return adopted.value;
      }
      for (const stale of existing.filter((b) => b.id !== live?.id && (b.state === "error" || b.dataExpiredAt))) yield* deleteSandbox(call, stale.id);
      const body = {
        from: snapshotId, name, labels: { dorks: label }, env, ...(machineType ? { type: machineType } : {}),
        ...(boatEnvironment ? { environment: boatEnvironment, noEnv: false } : { noEnv: true }),
        ttlSeconds: null,
      };
      const headers = { "Idempotency-Key": `dorks-${label}-${generation ?? 0}` };
      const created = yield* retryWhile(call("create", "POST", "/sandboxes", { body, headers }), { retryable: isTransient, everyMs: POLL_MS, withinMs: WAIT_MS, pause });
      return yield* bringUp(yield* createdId(created));
    });

  const pauseBox = (id: string) =>
    Effect.gen(function* () {
      const sandbox = Option.getOrUndefined(yield* getSandbox(call, id));
      if (!sandbox || sandbox.state === "archived" || sandbox.state === "cancelled") return;
      if (sandbox.state !== "archiving") {
        const stopped = yield* sandboxPath(id, "/stop").pipe(
          Effect.flatMap((p) => call("stop", "POST", p)),
          Effect.as(true),
          Effect.catchIf((e) => isBoatStatus(e, 404), () => Effect.succeed(false)),
        );
        if (!stopped) return;
      }
      yield* waitFor(id, new Set(["archived"]));
    });

  return { create, wake, pause: pauseBox };
}

const DesktopAnswer = Schema.Struct({ desktopUrl: Schema.optional(Schema.Unknown), provisioning: Schema.optional(Schema.Unknown) });

/**
 * Boat's live view (https://docs.boat.dev/api/reference/agent/get-desktop-streaming-url): `POST /desktop` streams the whole screen
 * over WebRTC. (Boat's `POST /browser` streams Chrome alone; not used: the desktop already shows Chrome, and a second viewer of it
 * takes the stream over.) A `provisioning` answer means the stream is still starting: ask again. The URL carries
 * its token in the `#fragment` and must be opened within 10 minutes, so it is minted per view and never kept. `overlay=0` hides
 * Boat's viewer chrome; it goes in the query, before the fragment.
 */
export const desktopUrl = (call: BoatCall, path: string, opts: DesktopOptions, pause: Pause, waitMs = DESKTOP_WAIT_MS) => {
  const op = "desktop";
  const ask = call(op, "POST", `${path}?${new URLSearchParams({ theme: opts.theme })}`).pipe(
    Effect.flatMap(decodeOr(DesktopAnswer, `boat ${op}: response had no stream URL`)),
    Effect.flatMap((json) => {
      const url = json.desktopUrl;
      if (typeof url === "string" && url.startsWith("https://")) return Effect.succeed(Option.some(withOverlayOff(url)));
      return json.provisioning ? Effect.succeedNone : Effect.fail(new BoatError(`boat ${op}: response had no stream URL`));
    }),
  );
  return pollUntil(ask, { everyMs: DESKTOP_POLL_MS, withinMs: waitMs, pause, onTimeout: () => new BoatError(`boat ${op}: the stream is still starting`, 503, "provisioning") });
};

function withOverlayOff(url: string): string {
  const hash = url.indexOf("#");
  const [base, fragment] = hash < 0 ? [url, ""] : [url.slice(0, hash), url.slice(hash)];
  return `${base}${base.includes("?") ? "&" : "?"}overlay=0${fragment}`;
}

const HostAnswer = Schema.Struct({ url: Schema.String.check(Schema.isStartingWith("https://")) });

/**
 * Boat's hosted ports (https://docs.boat.dev/hosting): `POST /host` answers `https://<sub>-<port>.on.boat.dev`, the same URL on every
 * call. Hosted `public`: a protected URL gates the page with a `_port_auth` cookie, which is third-party inside the Previews tab's
 * iframe, and the desktop shell's WebKit blocks it (the frame stays blank). A proxy through the server would have to rewrite every
 * root-relative asset and HMR socket of an unknown dev server. The URL is only as private as the sandbox subdomain.
 */
export const hostPort = (call: BoatCall, path: string, port: number, opts: HostPortOptions) =>
  call("host", "POST", path, { body: { port, public: true, ...(opts.title ? { title: opts.title } : {}), ...(opts.localhost ? { localhost: true } : {}) } }).pipe(
    Effect.flatMap(decodeOr(HostAnswer, "boat host: response had no URL")),
    Effect.map(({ url }) => {
      // Never keep a token: if Boat ever answers a protected URL despite `public`, drop the query rather than store a credential.
      const u = new URL(url);
      u.search = "";
      u.hash = "";
      return { url: u.toString() };
    }),
  );
