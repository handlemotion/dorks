import { appError, type FromBridge, type PrRef, type SubscriptionView, type ToBridge } from "@dorks/shared";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcServer, type RpcMethods } from "../src/rpc";
import type { CommandEntry, PushResult, Transport } from "../src/transport";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const tmp = (p = "bridge-") => mkdtempSync(join(tmpdir(), p));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(15);
  }
}

let built: string | null = null;
/**
 * Builds the bundle once per test process (the credential helper and the hooks run it as a child). Into a directory of its own: test files
 * run in parallel workers, and rebuilding a shared dist/cli.mjs while another worker executes it hands that worker a half-written file.
 */
export function builtCli() {
  if (built) return built;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = join(tmp("cli-"), "cli.mjs");
  execFileSync(process.execPath, [join(root, "scripts/build.mjs")], { stdio: "pipe", env: { ...process.env, DORKS_BUILD_OUT: out } });
  return (built = out);
}

/**
 * Runs `target` (the bundle, or any script) under `name` through a symlink, the way the snapshot installs `dorks` and `gh`.
 * Async on purpose: the RPC server under test lives in this process, so a blocking exec would deadlock.
 */
export function runAs(target: string, name: string, args: string[], env: NodeJS.ProcessEnv, pathDirs: string[] = [], input = "") {
  const bin = tmp("bin-");
  symlinkSync(target, join(bin, name));
  const nodeDir = tmp("node-"); // PATH has `node` (the shebang needs it) and nothing else: a gh installed on the dev machine must not leak in
  symlinkSync(process.execPath, join(nodeDir, "node"));
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(join(bin, name), args, { env: { ...env, PATH: [bin, ...pathDirs, nodeDir].join(":") } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: unknown }).code as number) : 0, stdout, stderr });
    });
    child.stdin!.end(input);
  });
}

const bridges: RpcServer[] = [];
export const closeBridges = () => bridges.splice(0).forEach((b) => b.close());

/** A stand-in for the running bridge: the same socket protocol, recording each call. `extra` overrides or adds methods. */
export async function fakeBridge(extra: RpcMethods = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const rec = (method: string, result: unknown = null): RpcMethods[string] => (params) => (calls.push({ method, params }), result);
  const server = new RpcServer(join(tmp("fake-bridge-"), "cred.sock"), { token: rec("token", { token: "ghs_fakeInstallationToken" }), "pr.sub": rec("pr.sub"), "pr.unsub": rec("pr.unsub"), "pr.list": rec("pr.list", []), ...extra });
  bridges.push(server);
  await server.start();
  return { calls, sock: server.sockPath, env: { DORKS_SOCK: server.sockPath } as NodeJS.ProcessEnv };
}

export const FAKE_GH = fileURLToPath(new URL("./fixtures/fake-gh.mjs", import.meta.url));

/** A bare "remote" at <base>/<owner>/<repo>.git with one commit on main. Returns the base URL for DORKS_GIT_BASE_URL. */
export function makeRemote(fullName = "acme/demo") {
  const base = tmp("remote-");
  const bare = join(base, `${fullName}.git`);
  mkdirSync(bare, { recursive: true });
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  sh(bare, "init", "--bare", "--initial-branch=main");
  const seed = tmp("seed-");
  sh(seed, "init", "--initial-branch=main");
  writeFileSync(join(seed, "README.md"), "# demo\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-m", "init");
  sh(seed, "push", bare, "main");
  return { baseUrl: `file://${base}`, bare, sh };
}

type ConfigureFrame = Extract<ToBridge, { t: "configure" }>;

export class FakeTransport implements Transport {
  pushes: FromBridge[][] = [];
  afterBridgeSeq = 0;
  connectCalls = 0;
  connectError: unknown = null;
  pushImpl: ((frames: FromBridge[]) => Promise<PushResult>) | null = null;
  configureFrame: ConfigureFrame | null = null;
  configureCalls = 0;
  configureFailures = 0;
  configureDelayMs = 0;
  token: string | null = "tok-initial-123456";
  heartbeats = 0;
  private cmdCb: ((c: CommandEntry[]) => void) | null = null;
  private reconnectCb: (() => void) | null = null;
  closed = false;
  /** The backend's view: what `bridge.subscriptions` would return. subscribePr/unsubscribePr edit it like the real mutations do. */
  subscriptions: SubscriptionView[] = [];
  prCalls: { op: "sub" | "unsub"; ref: PrRef; source?: string }[] = [];
  prError: unknown = null;
  prHang = false;
  subscriptionsWatchers = 0;
  /** Set false to simulate a backend that has not answered the subscriptions query yet. */
  pushInitialSubscriptions = true;
  private subsCb: ((views: unknown) => void) | null = null;

  get frames(): FromBridge[] {
    return this.pushes.flat();
  }
  events() {
    return this.frames.filter((f): f is Extract<FromBridge, { t: "event" }> => f.t === "event");
  }
  of<T extends FromBridge["t"]>(t: T) {
    return this.frames.filter((f): f is Extract<FromBridge, { t: T }> => f.t === t);
  }

  connect = async () => {
    this.connectCalls++;
    if (this.connectError) throw this.connectError;
    return { afterBridgeSeq: this.afterBridgeSeq };
  };
  push = async (frames: FromBridge[]) => {
    if (this.pushImpl) {
      const r = await this.pushImpl(frames);
      if (!(r && typeof r === "object" && ("expectedBseq" in r || (r as { ok?: unknown }).ok === false))) this.pushes.push(frames); // rejected batches are not stored
      return r;
    }
    this.pushes.push(frames);
  };
  heartbeat = async () => void this.heartbeats++;
  configure = async () => {
    this.configureCalls++;
    if (this.configureDelayMs) await new Promise((r) => setTimeout(r, this.configureDelayMs));
    if (this.configureFailures-- > 0) throw new Error("network blip");
    return this.configureFrame;
  };
  ghToken = async () => this.token;
  subscribeCommands(cb: (c: CommandEntry[]) => void) {
    this.cmdCb = cb;
    return () => {};
  }
  subscribePr = async (ref: PrRef, source: "auto" | "agent") => {
    this.prCalls.push({ op: "sub", ref, source });
    if (this.prHang) return new Promise<void>(() => {});
    if (this.prError) throw this.prError;
    const repo = ref.repo.toLowerCase(); // the backend stores repos lowercase
    if (!this.subscriptions.some((s) => s.repo === repo && s.number === ref.number)) this.setSubscriptions([...this.subscriptions, fakeView({ ...ref, repo }, source)]);
  };
  unsubscribePr = async (ref: PrRef) => {
    this.prCalls.push({ op: "unsub", ref });
    if (this.prError) throw this.prError;
    this.setSubscriptions(this.subscriptions.filter((s) => !(s.repo === ref.repo.toLowerCase() && s.number === ref.number)));
  };
  subscribeSubscriptions(cb: (views: unknown) => void) {
    this.subscriptionsWatchers++;
    this.subsCb = cb;
    if (this.pushInitialSubscriptions) cb(this.subscriptions);
    return () => void (this.subsCb = null);
  }
  setSubscriptions(list: SubscriptionView[]) {
    this.subscriptions = list;
    this.subsCb?.(list);
  }
  onReconnect(cb: () => void) {
    this.reconnectCb = cb;
    return () => {};
  }
  isFatal = (e: unknown) => (e as { data?: { code?: string } })?.data?.code === "forbidden";
  isSleeping = (e: unknown) => (e as { data?: { code?: string } })?.data?.code === "sleeping";
  errorCode = (e: unknown) => appError.safeParse((e as { data?: unknown })?.data).data?.code;
  close = async () => void (this.closed = true);

  emit(cmds: CommandEntry[]) {
    this.cmdCb?.(cmds);
  }
  reconnect() {
    this.reconnectCb?.();
  }
}

export const fakeView = (ref: PrRef, source: SubscriptionView["source"] = "agent"): SubscriptionView => ({
  ...ref,
  url: `https://github.com/${ref.repo}/pull/${ref.number}`,
  source,
  status: "active",
  ci: "unknown",
  review: "none",
  mergeable: null,
  ciFixAttempts: 0,
  state: "open",
});
