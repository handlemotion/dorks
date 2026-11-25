import { commandFrame, effortLevel, type EffortLevel, type CrewRole, type FromBridge, type McpServerConfig, type PrRef, type SkillRef } from "@dorks/shared";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { Agent, BOAT_COMPUTER_DRIVER, childEnv, COMPUTER_PROMPT, computerArgs, configDirOf, crewArgs, findTranscripts } from "./claude";
import { CodexAgent } from "./codex";
import { COORDINATOR_GUIDANCE, FINAL_ANSWER_GUIDANCE, SKILLS_GUIDANCE, WORKER_GUIDANCE } from "./guidance";
import { OpenCodeAgent } from "./opencode";
import { AntigravityAgent } from "./antigravity";
import type { Config } from "./config";
import { GithubToken, helperCommand } from "./credentials";
import { McpOAuthProxy, type ProxyRoute } from "./mcp-proxy";
import { SecretInputs } from "./inputs";
import { HookService, mcpConfigPath, settingsPath, userMcpServers, writeClaudeMcpConfig, writeClaudeSettings } from "./hooks";
import { resolveIdentity, type Identity } from "./runas";
import { EventPipeline } from "./events";
import { prepareRepo, prepareWorkDir, SetupError } from "./git";
import { Outbox } from "./outbox";
import { previewMethods } from "./previews";
import { PreviewProxies } from "./preview-proxy";
import { prLabel } from "./pr-ref";
import { prLookup } from "./pr-lookup";
import { PrSubscriptions } from "./prs";
import { errTag, type Log, type Redactor } from "./redact";
import { RpcServer, type RpcMethods } from "./rpc";
import { Services } from "./services";
import { claudeOneShot, cleanTitle, titlePrompt } from "./title";
import { syncSkills } from "./skills";
import { FileWatcher } from "./files";
import type { CommandEntry, Transport } from "./transport";

const EFFORTS = effortLevel.options;
/** The verify judge must answer inside the Stop hook's 60 s, beside the git scan. */
const JUDGE_TIMEOUT_MS = 40_000;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
type AnyAgent = Agent | CodexAgent | OpenCodeAgent | AntigravityAgent;
/** Codex, OpenCode and Antigravity start their session after the process: messages wait for it. Claude Code takes them at once. */
const isReady = (agent: AnyAgent) => agent instanceof Agent || agent.ready;
const isIdleEvent = (raw: unknown) => {
  const m = raw as { type?: unknown; subtype?: unknown; state?: unknown } | null;
  return m?.type === "system" && m.subtype === "session_state_changed" && m.state === "idle";
};
/** What Claude Code gets as appended system prompts (claude.ts), as one system prompt (OpenCode) or always-on rule (Antigravity). */
function agentSystem(role: CrewRole | null, driverPresent = existsSync(BOAT_COMPUTER_DRIVER)) {
  return [`${FINAL_ANSWER_GUIDANCE} ${SKILLS_GUIDANCE}`, role === "coordinator" ? COORDINATOR_GUIDANCE : role === "worker" ? WORKER_GUIDANCE : "", driverPresent ? COMPUTER_PROMPT : ""]
    .filter(Boolean)
    .join("\n\n");
}

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
  private rpc: RpcServer;
  private github: GithubToken;
  private prs: PrSubscriptions;
  private hooks: HookService;
  /** The build's services (services.ts): started on demand by the agent. */
  private services: Services;
  private previewRpc: RpcMethods;
  /** Secure inputs (docs/secure-inputs.md): the owner's values, in memory only. */
  private inputs: SecretInputs;
  /** The owner's OAuth MCP servers, behind a loopback proxy that adds a current token (mcp-proxy.ts). */
  private mcpProxy: McpOAuthProxy;
  private runAs: Identity | null;
  private agent: AnyAgent | null = null;
  private provider: "claude" | "codex" | "opencode" | "antigravity" = "claude";
  /** The owner's MCP servers as Claude Code config entries, from the last configure (OpenCode translates them into its own config). */
  private userMcp: Record<string, unknown> = {};
  private codexModel: { model: string; effort: string } | undefined;
  private claudeModel: { model?: string; effort?: string; fast?: boolean; codeMode?: boolean } = {};
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
  /** Lists the working tree for the composer's `@` menu (files.ts). */
  private files: FileWatcher | null = null;
  private filesDir = "";
  /** The first message to name the dork after, until a name is sent (or tried) by this process. */
  private nameFrom: string | null = null;
  /** The dork's place in a crew (docs/crew.md), from the last configure: its guidance and the crew tools its MCP server lists. */
  private role: CrewRole | null = null;
  private naming = false;
  private readonly cfg: Config;
  /** [node, cli.mjs]: how the git credential helper and the hooks invoke this binary. */
  private readonly self: [string, string];
  private readonly t: Transport;
  private readonly log: Log;
  private readonly redactor: Redactor;
  private readonly previews: PreviewProxies;

  constructor(private d: BridgeDeps) {
    this.cfg = d.cfg;
    this.self = d.selfCommand ?? [process.execPath, process.argv[1]!];
    this.t = d.transport;
    this.log = d.log;
    this.redactor = d.redactor;
    this.previews = new PreviewProxies(join(this.cfg.stateDir, "previews.json"), this.log);
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
    this.runAs = this.cfg.runAs ? resolveIdentity(this.cfg.runAs) : null;
    this.github = new GithubToken(["github.com", host].filter(Boolean));
    this.prs = new PrSubscriptions(this.t, this.log);
    const env = this.d.baseEnv ?? process.env;
    this.inputs = new SecretInputs(this.t, this.redactor, this.log);
    this.hooks = new HookService({
      inputs: this.inputs,
      workDir: this.cfg.workDir,
      stateDir: this.cfg.stateDir,
      env,
      runAs: this.runAs,
      prs: this.prs,
      prStatus: prLookup(env, this.self[1], () => this.github.get()),
      services: () => this.services.summary(),
      judge: (prompt) => this.judge(prompt),
      // Claude only for now (the one agent tested live, AGENTS.md); a crew coordinator writes no code.
      skipVerify: () => this.provider !== "claude" || this.role === "coordinator",
      log: this.log,
    });
    this.previewRpc = previewMethods(this.t, this.log, () => this.role, this.previews, this.cfg.bridgePort);
    this.services = new Services({
      workDir: this.cfg.workDir,
      logDir: "/tmp/dorks-services",
      runAs: this.runAs,
      env: () => this.agentCtx?.env ?? null,
      showPreview: async (port, title) => obj(await this.previewRpc["preview.show"]({ port, title })).url as string | undefined,
      onStart: (name) => this.hooks.activity.service(name),
      log: this.log,
    });
    // With privilege separation the socket lives in a directory only the Claude user can enter (the state dir itself stays root-only,
    // traversable so that path resolves).
    const sockDir = this.cfg.sockDir ?? this.cfg.stateDir;
    this.mcpProxy = new McpOAuthProxy(
      (name, stale) => this.t.mcpToken(name, stale),
      this.log,
      (v) => this.redactor.add(v),
    );
    this.rpc = new RpcServer(join(sockDir, this.runAs ? "cred/cred.sock" : "cred.sock"), this.rpcMethods(), this.runAs);
    this.written = this.loadWritten();
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    mkdirSync(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    if (this.runAs) chmodSync(this.cfg.stateDir, 0o711); // others may traverse to cred/ and the settings file, not list or read
    writeClaudeSettings(this.cfg.stateDir, this.self);
    writeClaudeMcpConfig(this.cfg.stateDir, this.self, this.rpc.sockPath);
    if (this.runAs) {
      // cred/ sits in the socket dir, which the Claude user must be able to traverse (not list) to reach it
      const sockDir = dirname(dirname(this.rpc.sockPath));
      mkdirSync(sockDir, { recursive: true, mode: 0o711 });
      chmodSync(sockDir, 0o711);
    }
    await this.rpc.start();
    await this.mcpProxy.start();
    await this.previews.restore(); // after a resume: the hosted URLs still point at these ports
    await this.handshake(true);
    this.prs.start();
    this.unsubs.push(
      this.t.subscribeCommands(
        (cmds) => this.onCommands(cmds),
        () => this.log("commands subscription error"),
      ),
    );
    this.unsubs.push(
      this.t.onReconnect(
        () =>
          void this.handshake(false)
            .then(() => !this.closed && this.prs.start())
            .catch((e) => e instanceof SleepingError && this.d.onSleeping?.()),
      ),
    );
    this.hb = setInterval(() => {
      this.t.heartbeat().catch((e) => this.t.isFatal(e) && this.fatal());
    }, this.cfg.heartbeatMs);
    this.hb.unref();
  }

  /**
   * connect → afterBridgeSeq. On a reconnect this also replays everything above it from the outbox. A refusal with `sleeping`
   * throws SleepingError; transient failures are retried (the transport is already reconnecting underneath).
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
    this.prs.stop();
    this.files?.stop();
    this.services.stopAll();
    this.rpc.close();
    this.mcpProxy.close();
    this.previews.close();
    await this.t.close();
  }

  /** The local RPC table (rpc.ts): what the git helper, the `dorks` CLI and the `gh` shim can ask of this process. */
  private rpcMethods() {
    return { token: this.github.rpc, ...this.prs.methods, ...this.previewRpc, ...this.inputs.methods, ...this.hooks.methods, ...this.services.methods };
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
      if (f.t === "user_message" || f.t === "notify") {
        if (this.acked.has(f.id)) continue;
        this.enqueue(() => this.deliver(f.id, f.text, f.t === "notify" ? f : undefined));
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

  /** A user turn for the agent: a `user_message`, or a `notify` (autonomy digest, already wrapped by the backend; written verbatim). */
  private async deliver(id: string, text: string, notify?: { kinds: string[]; prs: PrRef[] }) {
    if (this.acked.has(id)) return;
    if (!this.written.has(id)) {
      if (!this.agent?.alive || !isReady(this.agent)) return; // agent not up yet (or dead): reprocessed after configure; left unacked so the backend keeps it
      // A notify never goes into a running turn: the CLI would fold it in as a side note the agent can skip. The backend holds them
      // mid-turn too, but it cannot see a turn the agent starts itself (a background task finished) until that turn's first event
      // arrives. Left unwritten and unacked; the next idle walks the commands again.
      if (notify && !this.agent.idle) return;
      try {
        await this.agent.sendUserMessage(text);
      } catch {
        return this.log("could not write message to the agent");
      }
      this.written.add(id);
      this.persistWritten(id);
      this.hooks.noteTurn(notify?.kinds ?? [], text);
      if (notify) this.log("notify delivered:", notify.kinds.join(",") || "-", notify.prs.map(prLabel).join(",") || "-"); // never the text
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
      this.github.set(token);
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
    // Whole-fs flush, best effort (a missing binary is fine). It can take seconds on a box with many dirty pages, so the wait is
    // bounded: the transcript above is already fsynced, and a flush must not hang on unrelated writes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([new Promise<void>((r) => execFile("sync", () => r())), new Promise<void>((r) => (timer = setTimeout(r, this.cfg.flushSyncWaitMs)))]);
    clearTimeout(timer);
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
    const userMcp = userMcpServers(cfg.mcpServers ?? [], (name) => this.mcpProxy.urlFor(name));
    this.proxyOAuthServers(cfg.mcpServers ?? []);
    this.redactor.addAll(Object.values(userMcp.env));
    this.github.set(cfg.ghToken);
    // Values the owner gave earlier in this session (a restart or a wake forgot them): known before the agent runs a tool again.
    await this.inputs.refresh().catch((e) => this.log("could not fetch the inputs:", errTag(e)));

    const provider = cfg.provider ?? "claude";
    const env = childEnv(this.d.baseEnv ?? process.env, cfg.env, this.log, this.runAs);
    // The owner's skills (docs/skills.md), before the agent starts so its first turn has them. Not in the key: the CLI reloads them.
    await this.syncSkills(provider, env, cfg.skills);
    const key = createHash("sha256")
      .update(
        JSON.stringify([provider, cfg.codexModel, cfg.model ?? null, cfg.effort ?? null, !!cfg.fast, !!cfg.codeMode, cfg.repo, Object.entries(cfg.env).sort(), cfg.mcpServers ?? [], cfg.role ?? null]),
      )
      .digest("hex");
    if (this.agent?.alive && key === this.agentKey) {
      // Already running with this config (a reconnect re-sends configure): nothing to do but say so again.
      this.pipeline.control({ t: "ack", id: cid });
      if (isReady(this.agent)) this.pipeline.control({ t: "ready" }, true);
      return;
    }
    await this.stopForRestart();
    const dir = await this.prepareDir(cid, cfg.repo);
    if (dir === null) return;

    env.DORKS_SOCK = this.rpc.sockPath; // how `dorks`, the gh shim and hooks (children of the CLI) find this process
    // The owner's MCP servers (Customize): the config file names them with `${DORKS_MCP_…}` references the CLI expands from this env.
    Object.assign(env, userMcp.env);
    writeClaudeMcpConfig(this.cfg.stateDir, this.self, this.rpc.sockPath, userMcp.config);
    this.userMcp = userMcp.config;
    this.agentCtx = { dir, env };
    this.services.set(cfg.services ?? []);
    this.agentKey = key;
    this.provider = provider;
    this.role = cfg.role ?? null;
    this.codexModel = cfg.codexModel;
    this.claudeModel = { model: cfg.model, effort: cfg.effort, fast: cfg.fast, codeMode: cfg.codeMode };
    this.startAgent(this.resumableSession(provider, env, cfg.resumeSessionId), []);
    this.pipeline.control({ t: "ack", id: cid });
    this.nameFrom = cfg.nameFrom ?? null;
    if (provider === "claude") {
      this.pipeline.control({ t: "ready" }, true);
      this.name();
    }
    this.process(); // messages that arrived before the agent was up, and interrupts deferred during configure
  }

  private async syncSkills(provider: string, env: NodeJS.ProcessEnv, skills: readonly SkillRef[] = []) {
    if (provider === "codex") return; // Codex sessions do not get skills yet; OpenCode and Antigravity read the same skills directory as Claude Code
    await syncSkills({ stateDir: this.cfg.stateDir, configDir: configDirOf(env), runAs: this.runAs, fetch: (n) => this.t.skill(n), log: this.log }, skills);
  }

  /** The OAuth servers go behind the proxy; their saved headers stay out of the agent's env, but not out of the redactor. */
  private proxyOAuthServers(servers: readonly McpServerConfig[]) {
    const proxied = new Map<string, ProxyRoute>();
    for (const s of servers) {
      if (s.transport !== "http" || !s.oauth) continue;
      proxied.set(s.name, { url: s.url, headers: s.headers });
      this.redactor.addAll(Object.values(s.headers));
    }
    this.mcpProxy.set(proxied);
  }

  /** Config changed (a new model, say): restart on the same session, but never mid-turn. Messages queue behind this job, so the next one goes to the restarted agent. */
  private async stopForRestart() {
    if (!this.agent) return;
    while (this.agent.alive && !(await this.agent.waitIdle(60_000))) this.log("configure: waiting for the turn to end before restarting");
    this.lastSessionId = this.agent.sessionId ?? this.lastSessionId;
    await this.agent.stop();
    this.agent = null;
  }

  /** Clones the repo (or makes the bare workdir). On failure, acks the command, reports the agent as exited and returns null. */
  private async prepareDir(cid: string, repo: Parameters<typeof prepareRepo>[1] | null): Promise<string | null> {
    try {
      const gitCtx = { gitBaseUrl: this.cfg.gitBaseUrl, workDir: this.cfg.workDir, helper: helperCommand(...this.self, this.rpc.sockPath), log: this.log, env: this.d.baseEnv, runAs: this.runAs };
      return repo ? await prepareRepo(gitCtx, repo) : await prepareWorkDir(gitCtx);
    } catch (e) {
      const step = e instanceof SetupError ? e.step : "repo setup";
      this.log("repo setup failed:", step);
      this.pipeline.control({ t: "ack", id: cid });
      this.pipeline.control({ t: "agent_exited", code: null, stderrTail: `setup failed: ${step}` }, true);
      return null;
    }
  }

  /**
   * The session to resume. The backend remembers a session id, but the box may have been recreated without its disk: --resume would
   * fail and the user's message with it. Only resume what is really on disk.
   */
  private resumableSession(provider: string, env: NodeJS.ProcessEnv, remembered: string | null): string | null {
    const resume = this.lastSessionId ?? remembered;
    if (provider === "claude" && resume && findTranscripts(configDirOf(env), resume).length === 0) {
      this.log("session transcript not found on this box, starting a fresh session");
      this.lastSessionId = null;
      return null;
    }
    return resume;
  }

  private startAgent(resume: string | null, resend: string[]) {
    const { dir, env } = this.agentCtx!;
    const shared = {
      cwd: dir,
      env,
      resumeSessionId: resume,
      runAs: this.runAs,
      redactor: this.redactor,
      log: this.log,
      onRaw: (raw: unknown) => {
        const sid = agent.sessionId;
        if (sid) this.lastSessionId = sid;
        this.hooks.activity.ingest(raw); // the turn's tool calls, for the verify gate
        this.pipeline.ingest(this.inputs.scrubDeep(raw)); // a secure input never reaches the transcript
        // A turn boundary: a notify held back while the agent was busy (see deliver) can go out now.
        if (isIdleEvent(raw) && this.agent === agent) this.process();
      },
      onExit: ({ code, stderrTail, resumeMissing, pending }: { code: number | null; stderrTail: string; resumeMissing: boolean; pending: string[] }) => {
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
    };
    const stopReason = async (sessionId: string) => {
      const result = await this.hooks.methods["hook.stop"]({ session_id: sessionId });
      return result && typeof result === "object" && "reason" in result && typeof result.reason === "string" ? result.reason : null;
    };
    const onReady = () => {
      this.pipeline.control({ t: "ready" }, true);
      this.process();
      this.name();
    };
    const sessionContext = async () => {
      const out = obj(await this.hooks.methods["hook.sessionStart"]({}));
      const context = obj(out.hookSpecificOutput).additionalContext;
      return typeof context === "string" && context ? context : null;
    };
    // Claude Code runs these as hooks; the other agents' finished tool calls arrive on their event streams, so the bridge calls them itself.
    // Hooks fail open and log their own errors.
    const onShell = (command: string, output: string) => {
      this.hooks.activity.shell(command);
      void this.hooks.methods["hook.postToolUse"]({ tool_name: "Bash", tool_input: { command }, tool_response: { stdout: output } });
    };
    const onIssue = (message: string) => this.pipeline.control({ t: "codex_issue", message: message.slice(0, 1000) }, true);
    const agent: AnyAgent =
      this.provider === "antigravity"
        ? new AntigravityAgent({
            ...shared,
            model: this.claudeModel.model,
            mcpCommand: this.self,
            sock: this.rpc.sockPath,
            userMcp: this.userMcp,
            skillsDir: join(configDirOf(env), "skills"),
            system: agentSystem(this.role),
            onModels: (models) => this.pipeline.control({ t: "agent_models", models: models.map((m) => ({ ...m, efforts: [] })), effort: null }, true),
            onIssue,
            onReady,
            onTurnFinished: stopReason,
            onShell,
            sessionContext,
          })
        : this.provider === "opencode"
          ? new OpenCodeAgent({
              ...shared,
              model: this.claudeModel.model,
              mcpCommand: this.self,
              sock: this.rpc.sockPath,
              userMcp: this.userMcp,
              skillsDir: join(configDirOf(env), "skills"),
              stateDir: this.cfg.stateDir,
              system: agentSystem(this.role),
              onModels: (models) =>
                this.pipeline.control(
                  { t: "agent_models", models: models.slice(0, 100).map((model) => ({ model, name: model.slice(model.indexOf("/") + 1).slice(0, 80), efforts: [] })), effort: null },
                  true,
                ),
              onIssue,
              onReady,
              onTurnFinished: stopReason,
              onShell,
              sessionContext,
            })
          : this.provider === "codex"
            ? new CodexAgent({
                ...shared,
                model: this.codexModel,
                mcpCommand: this.self,
                sock: this.rpc.sockPath,
                onModels: (models) => this.pipeline.control({ t: "codex_models", models }, true),
                onIssue: (message) => this.pipeline.control({ t: "codex_issue", message }, true),
                onReady,
                onTurnFinished: stopReason,
              })
            : new Agent({
                ...shared,
                loadImage: (id) => this.t.getImage(id),
                bin: this.cfg.claudeBin,
                permissionMode: this.cfg.permissionMode,
                extraArgs: [...computerArgs(), ...crewArgs(this.role), ...this.cfg.claudeExtraArgs],
                model: this.claudeModel.model,
                effort: this.claudeModel.effort,
                onCommands: (commands) => this.pipeline.control({ t: "agent_commands", commands }, true),
                onModels: (models) => {
                  const effort = this.claudeModel.effort;
                  this.pipeline.control({ t: "agent_models", models, effort: effort && (EFFORTS as readonly string[]).includes(effort) ? (effort as EffortLevel) : null }, true);
                },
                settingsFile: settingsPath(this.cfg.stateDir, this.claudeModel),
                mcpConfigFile: mcpConfigPath(this.cfg.stateDir),
              });
    this.agent = agent;
    this.watchFiles(dir);
    this.hooks.turnBoundary(); // the verify gate judges each turn against the trees as they are now
    this.log("agent started", resume ? "(resuming a session)" : "(new session)");
    for (const text of resend) void agent.sendUserMessage(text).catch(() => this.log("could not resend a message to the new session"));
  }

  /** The repository's files for the composer's `@` menu: one watcher per working directory, kept across agent restarts. */
  private watchFiles(dir: string) {
    if (this.files && this.filesDir === dir) return;
    this.files?.stop();
    this.filesDir = dir;
    this.files = new FileWatcher({ dir, baseEnv: this.d.baseEnv ?? process.env, runAs: this.runAs, send: (l) => this.pipeline.control({ t: "files", ...l }, true) });
    this.files.start();
  }

  // ------------------------------------------------------------------ verify judge
  /** One answer from Haiku beside the agent (never in its session, nothing in its transcript), as the dork's title is made. */
  private async judge(prompt: string): Promise<string | null> {
    if (!(this.agent instanceof Agent) || !this.agentCtx) return null;
    const { env } = this.agentCtx;
    const reply = claudeOneShot({ bin: this.cfg.claudeBin, env, cwd: this.runAs?.home ?? env.HOME ?? this.cfg.stateDir, runAs: this.runAs, prompt });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([reply, new Promise<null>((r) => (timer = setTimeout(() => r(null), JUDGE_TIMEOUT_MS)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ title
  /** Names the dork after its first message, beside the agent (never in its session). Best effort: a failure keeps the placeholder. */
  private name() {
    const message = this.nameFrom;
    const agent = this.agent;
    if (!message || this.naming || !agent || !this.agentCtx) return;
    this.naming = true;
    this.nameFrom = null;
    const prompt = titlePrompt(message);
    const { env } = this.agentCtx;
    const reply = agent instanceof Agent ? claudeOneShot({ bin: this.cfg.claudeBin, env, cwd: this.runAs?.home ?? env.HOME ?? this.cfg.stateDir, runAs: this.runAs, prompt }) : agent.oneShot(prompt);
    void reply
      .then((raw) => {
        const text = cleanTitle(raw ?? "");
        if (text) this.pipeline.control({ t: "title", text }, true);
        this.log(text ? "named the dork" : "title model gave no usable name");
      })
      .catch((e) => this.log("could not name the dork:", errTag(e)))
      .finally(() => {
        this.naming = false;
      });
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
      appendFileSync(this.journal(), `${id}\n`, { mode: 0o600 });
    } catch {
      /* in-memory dedupe still applies */
    }
  }
}
