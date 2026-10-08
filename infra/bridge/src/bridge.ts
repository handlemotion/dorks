import { commandFrame, type FromBridge } from "@dorks/shared";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { Agent, childEnv, configDirOf, findTranscripts } from "./claude";
import type { Config } from "./config";
import { CredentialServer, helperCommand } from "./credentials";
import { EventPipeline } from "./events";
import { prepareRepo, SetupError } from "./git";
import { Outbox } from "./outbox";
import { errTag, type Log, type Redactor } from "./redact";
import type { CommandEntry, Transport } from "./transport";

export interface BridgeDeps {
  cfg: Config;
  transport: Transport;
  log: Log;
  redactor: Redactor;
  /** The environment the Claude child inherits from (minus the reserved names). Default: process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** [node, cli.mjs]: what git's credential helper should invoke. */
  selfCommand?: [string, string];
  /** Called when the backend refuses us for good (exit 1). */
  onFatal?: () => void;
  /** Called when a reconnect is refused with `sleeping`: the box should be paused, exit 0. */
  onSleeping?: () => void;
}

/** Thrown from start() when the backend says the box should be asleep: the process exits 0. */
export class SleepingError extends Error {}

export class Bridge {
  readonly outbox: Outbox;
  readonly pipeline: EventPipeline;
  private creds: CredentialServer;
  private agent: Agent | null = null;
  private agentKey = "";
  private lastSessionId: string | null = null;
  private latest: CommandEntry[] = [];
  private handled = new Set<string>(); // non-message command ids already processed (the subscription re-emits until the ack lands)
  private acked = new Set<string>(); // user_message ids whose ack this process has queued
  private written: Set<string>; // user_message ids already written to the CLI (persisted: survives a bridge restart)
  private chain: Promise<unknown> = Promise.resolve();
  private unsubs: (() => void)[] = [];
  private hb: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private handshaking: Promise<void> | null = null;
  private configuring = 0; // configure jobs in flight (an interrupt arriving meanwhile is deferred, not dropped)
  private configAttempts = new Map<string, number>();
  private agentCtx: { dir: string; env: NodeJS.ProcessEnv } | null = null;
  private readonly cfg: Config;
  private readonly t: Transport;
  private readonly log: Log;
  private readonly redactor: Redactor;

  constructor(private d: BridgeDeps) {
    this.cfg = d.cfg;
    this.t = d.transport;
    this.log = d.log;
    this.redactor = d.redactor;
    this.outbox = new Outbox(this.t, this.log, {
      batchMs: this.cfg.batchMs,
      onFatal: () => this.fatal(),
      onRenumbered: (last) => this.pipeline.setSeq(last),
      onBackendAhead: (seq) => this.pipeline.continueFrom(seq),
    });
    this.pipeline = new EventPipeline(this.outbox, this.cfg.deltaBatchMs);
    const host = (() => {
      try {
        return new URL(this.cfg.gitBaseUrl).host;
      } catch {
        return "";
      }
    })();
    this.creds = new CredentialServer(join(this.cfg.stateDir, "cred.sock"), ["github.com", host].filter(Boolean));
    this.written = this.loadWritten();
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    await this.creds.start();
    await this.handshake(true);
    this.unsubs.push(this.t.subscribeCommands((cmds) => this.onCommands(cmds), () => this.log("commands subscription error")));
    this.unsubs.push(this.t.onReconnect(() => void this.handshake(false).catch((e) => e instanceof SleepingError && this.d.onSleeping?.())));
    this.hb = setInterval(() => {
      this.t.heartbeat().catch((e) => this.t.isFatal(e) && this.fatal());
    }, this.cfg.heartbeatMs);
    this.hb.unref();
  }

  /**
   * connect → afterBridgeSeq. On a reconnect this also replays everything above it from the outbox. A refusal with `sleeping`
   * throws SleepingError; transient failures are retried (the Convex client is already reconnecting underneath).
   */
  private handshake(first: boolean): Promise<void> {
    this.handshaking ??= (async () => {
      try {
        for (let attempt = 0; !this.closed; attempt++) {
          try {
            const { afterBridgeSeq } = await this.t.connect();
            this.pipeline.continueFrom(afterBridgeSeq);
            this.outbox.rewindAfter(afterBridgeSeq);
            this.log(first ? "connected, numbering from" : "reconnected, numbering from", this.pipeline.lastSeq + 1);
            return;
          } catch (e) {
            if (this.t.isSleeping(e)) throw new SleepingError("sleeping");
            if (this.t.isFatal(e)) return this.fatal();
            if (first && attempt === 0) this.log("connect failed, retrying:", errTag(e));
            await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** attempt)));
          }
        }
      } finally {
        this.handshaking = null;
      }
    })();
    return this.handshaking;
  }

  private fatal() {
    this.log("backend refused this bridge (forbidden); exiting");
    void this.agent?.stop(1000);
    this.d.onFatal?.();
  }

  /** Graceful shutdown: end the CLI, push what is queued (bounded), release resources. */
  async stop(drainMs = 5000) {
    if (this.closed) return;
    this.closed = true;
    this.unsubs.splice(0).forEach((u) => u());
    if (this.hb) clearInterval(this.hb);
    await this.agent?.stop(2000);
    this.pipeline.flushDelta();
    this.outbox.flushNow();
    await Promise.race([this.outbox.drained(), new Promise((r) => setTimeout(r, drainMs))]);
    this.outbox.stop();
    this.creds.close();
    await this.t.close();
  }

  // ------------------------------------------------------------------ commands
  private onCommands(cmds: CommandEntry[]) {
    this.latest = cmds;
    this.process();
  }

  /** Walks the latest command snapshot. Idempotent: safe to call again after configure finishes. */
  private process() {
    for (const c of this.latest) {
      const parsed = commandFrame.safeParse(c.frame);
      if (!parsed.success) continue;
      const f = parsed.data;
      if (f.t === "user_message") {
        if (this.acked.has(f.id)) continue;
        this.enqueue(() => this.userMessage(f.id, f.text));
        continue;
      }
      if (this.handled.has(c.cid)) continue;
      if (f.t === "interrupt") {
        // Not queued behind a long flush. While configure is still starting the agent there is nothing to interrupt yet, but
        // dropping it would lose the user's Stop: leave it pending, process() runs again when the agent is up.
        if (!this.agent?.alive && this.configuring > 0) continue;
        this.handled.add(c.cid);
        void this.interrupt(c.cid);
        continue;
      }
      this.handled.add(c.cid);
      if (f.t === "fetch_configure") this.configuring++; // counted from the moment it is queued, so a later interrupt in this snapshot defers
      this.enqueue(() => (f.t === "fetch_configure" ? this.configureWithRetry(c.cid) : f.t === "flush" ? this.flush(c.cid, (f as { cid?: string }).cid ?? c.cid) : this.refreshToken(c.cid)));
    }
  }

  private enqueue(job: () => Promise<void>) {
    this.chain = this.chain.then(job).catch((e) => this.log("command failed:", errTag(e)));
  }

  private async userMessage(id: string, text: string) {
    if (this.acked.has(id)) return;
    if (!this.written.has(id)) {
      if (!this.agent?.alive) return; // agent not up yet (or dead): reprocessed after configure; left unacked so the backend keeps it
      try {
        await this.agent.sendUserMessage(text);
      } catch {
        return this.log("could not write message to the agent");
      }
      this.written.add(id);
      this.persistWritten(id);
    }
    this.acked.add(id);
    this.pipeline.control({ t: "ack", id }, true);
  }

  private async interrupt(cid: string) {
    try {
      if (this.agent?.alive) await this.agent.interrupt();
    } catch {
      this.log("interrupt could not be delivered");
    }
    this.pipeline.control({ t: "ack", id: cid }, true);
  }

  private async refreshToken(cid: string) {
    const token = await this.t.ghToken().catch(() => null);
    if (token) {
      this.redactor.add(token);
      this.creds.setToken(token);
      this.log("github token refreshed");
    } else this.log("github token refresh failed; keeping the current one");
    this.pipeline.control({ t: "ack", id: cid }, true);
  }

  private async flush(cid: string, flushCid: string) {
    if (this.agent?.alive && !(await this.agent.waitIdle(this.cfg.flushIdleWaitMs))) {
      // Still mid-turn after the grace period: stop the turn so the transcript is consistent before the box pauses.
      this.log("flush: agent still mid-turn, interrupting it");
      await this.agent.interrupt().catch(() => {});
      await this.agent.waitIdle(this.cfg.flushInterruptWaitMs);
    }
    this.pipeline.flushDelta();
    await this.persistSession();
    this.pipeline.control({ t: "ack", id: cid });
    // The shared protocol is gaining an optional `cid` on `flushed` (echo of the flush command); older backends strip it.
    this.pipeline.control({ t: "flushed", cid: flushCid } as Exclude<FromBridge, { t: "event" }>, true);
  }

  /** The CLI appends its transcript as it goes; make sure the OS has it (and the working tree) on disk before the box pauses. */
  private async persistSession() {
    const id = this.agent?.sessionId ?? this.lastSessionId;
    try {
      if (id && this.agentCtx) {
        for (const f of findTranscripts(configDirOf(this.agentCtx.env), id)) {
          const fd = openSync(f, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
    } catch {
      this.log("could not fsync the session transcript");
    }
    await new Promise<void>((r) => execFile("sync", () => r())); // whole-fs flush; best effort (missing binary is fine)
  }

  // ------------------------------------------------------------------ configure
  /** A transient failure fetching the config (network blip, action timeout) must not strand the command: retry it with backoff. */
  private async configureWithRetry(cid: string) {
    try {
      await this.configure(cid);
      this.configAttempts.delete(cid);
    } catch (e) {
      const n = (this.configAttempts.get(cid) ?? 0) + 1;
      this.configAttempts.set(cid, n);
      const wait = Math.min(30_000, 500 * 2 ** (n - 1));
      this.log(`configure failed (${this.t.errorCode(e) ?? errTag(e)}), retrying in ${wait}ms`);
      this.handled.delete(cid);
      const timer = setTimeout(() => !this.closed && this.process(), wait);
      timer.unref();
    } finally {
      this.configuring--;
    }
  }

  private async configure(cid: string) {
    const cfg = await this.t.configure();
    if (!cfg) return this.log("configure refused (the backend recorded why)");
    this.redactor.add(cfg.ghToken);
    this.redactor.addAll(Object.values(cfg.env));
    this.creds.setToken(cfg.ghToken);

    const key = createHash("sha256").update(JSON.stringify([cfg.repo, Object.entries(cfg.env).sort()])).digest("hex");
    if (this.agent?.alive && key === this.agentKey) {
      // Already running with this config (a reconnect re-sends configure): nothing to do but say so again.
      this.pipeline.control({ t: "ack", id: cid });
      return this.pipeline.control({ t: "ready" }, true);
    }
    if (this.agent) {
      // config changed: restart on the same session
      this.lastSessionId = this.agent.sessionId ?? this.lastSessionId;
      await this.agent.stop();
      this.agent = null;
    }

    let dir: string;
    try {
      dir = await prepareRepo(
        { gitBaseUrl: this.cfg.gitBaseUrl, workDir: this.cfg.workDir, helper: helperCommand(...(this.d.selfCommand ?? [process.execPath, process.argv[1]!]), this.creds.sockPath), log: this.log, env: this.d.baseEnv },
        cfg.repo,
      );
    } catch (e) {
      const step = e instanceof SetupError ? e.step : "repo setup";
      this.log("repo setup failed:", step);
      this.pipeline.control({ t: "ack", id: cid });
      return this.pipeline.control({ t: "agent_exited", code: null, stderrTail: `setup failed: ${step}` }, true);
    }

    const env = childEnv(this.d.baseEnv ?? process.env, cfg.env, this.log);
    this.agentCtx = { dir, env };
    this.agentKey = key;
    let resume = this.lastSessionId ?? cfg.resumeSessionId;
    // The backend remembers a session id, but the box may have been recreated without its disk: --resume would fail and the
    // user's message with it. Only resume what is really on disk.
    if (resume && findTranscripts(configDirOf(env), resume).length === 0) {
      this.log("session transcript not found on this box, starting a fresh session");
      this.lastSessionId = null;
      resume = null;
    }
    this.startAgent(resume, []);
    this.pipeline.control({ t: "ack", id: cid });
    this.pipeline.control({ t: "ready" }, true);
    this.process(); // messages that arrived before the agent was up, and interrupts deferred during configure
  }

  private startAgent(resume: string | null, resend: string[]) {
    const { dir, env } = this.agentCtx!;
    const agent = new Agent({
      bin: this.cfg.claudeBin,
      cwd: dir,
      env,
      permissionMode: this.cfg.permissionMode,
      resumeSessionId: resume,
      extraArgs: this.cfg.claudeExtraArgs,
      redactor: this.redactor,
      log: this.log,
      onRaw: (raw) => {
        const sid = agent.sessionId;
        if (sid) this.lastSessionId = sid;
        this.pipeline.ingest(raw);
      },
      onExit: ({ code, stderrTail, resumeMissing, pending }) => {
        if (this.agent === agent) this.agent = null;
        if (resumeMissing) {
          // Raced the preflight (or the transcript was unreadable): retry once on a fresh session, replaying what it never answered.
          this.log("resume failed: no such conversation; starting a fresh session");
          this.lastSessionId = null;
          this.startAgent(null, pending);
          this.process(); // messages the doomed CLI never read
          return;
        }
        this.log("agent exited, code", code);
        this.pipeline.control({ t: "agent_exited", code, stderrTail }, true);
      },
    });
    this.agent = agent;
    this.log("agent started", resume ? "(resuming a session)" : "(new session)");
    for (const text of resend) void agent.sendUserMessage(text).catch(() => this.log("could not resend a message to the new session"));
  }

  // ------------------------------------------------------------------ dedupe journal
  private journal() {
    return join(this.cfg.stateDir, "messages.log");
  }

  private loadWritten(): Set<string> {
    try {
      return new Set(readFileSync(this.journal(), "utf8").split("\n").filter(Boolean).slice(-2000));
    } catch {
      return new Set();
    }
  }

  private persistWritten(id: string) {
    try {
      mkdirSync(this.cfg.stateDir, { recursive: true, mode: 0o700 });
      appendFileSync(this.journal(), `${id}\n`);
    } catch {
      /* in-memory dedupe still applies */
    }
  }
}
