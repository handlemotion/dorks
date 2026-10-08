import type { FromBridge, ToBridge } from "@dorks/shared";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Builds dist/cli.mjs once (the credential helper runs it as a child of git). */
export function builtCli() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(process.execPath, [join(root, "scripts/build.mjs")], { stdio: "pipe" });
  return join(root, "dist/cli.mjs");
}

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
  onReconnect(cb: () => void) {
    this.reconnectCb = cb;
    return () => {};
  }
  isFatal = (e: unknown) => (e as { data?: { code?: string } })?.data?.code === "forbidden";
  isSleeping = (e: unknown) => (e as { data?: { code?: string } })?.data?.code === "sleeping";
  errorCode = (e: unknown) => (e as { data?: { code?: string } })?.data?.code;
  close = async () => void (this.closed = true);

  emit(cmds: CommandEntry[]) {
    this.cmdCb?.(cmds);
  }
  reconnect() {
    this.reconnectCb?.();
  }
}
