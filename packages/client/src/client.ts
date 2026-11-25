import type {
  AutomationInput,
  AutomationRunView,
  AutomationView,
  CommentView,
  ComposioStatus,
  DorkMode,
  McpServerInput,
  McpServerView,
  MergeMethod,
  PullRequestView,
  SkillView,
  SubscriptionView,
  WorkspaceRoot,
  WorkspaceTree,
} from "@dorks/shared";
import { EventsFeed } from "./events.ts";
import { createApi, ApiError, type ApiConfig, type DesktopOptions, type NewComment } from "./http.ts";
import { connectLive, type LiveStatus } from "./live.ts";
import { Query, type QueryOptions, type Store } from "./store.ts";
import type {
  BuildInput,
  BuildVarInput,
  BuildView,
  CreateDorkInput,
  Dork,
  LiveMessage,
  PrRefInput,
  RunView,
  Settings,
  SettingsPatch,
  SnapshotStatus,
  Usage,
  GithubRepos,
  SentryProjects,
  LocalAccess,
  LocalDecision,
  PhoneStatus,
  InputAnswer,
} from "./types.ts";

export interface ClientConfig extends ApiConfig {
  /** Events fetched for a transcript's first (newest) page. */
  pageSize?: number;
  /** Events fetched per older page (`loadMore`); the server caps a page at 200. Default: 150, or `pageSize` when that is larger. */
  olderPageSize?: number;
  /** Delay before retry n of a failed read and before reconnect attempt n of the live stream. */
  retryDelay?: (n: number) => number;
}

export interface ConnectionState {
  live: LiveStatus;
  /** The server answered 401: the owner token is wrong, and nothing will succeed until the app supplies a new one. */
  unauthorized: boolean;
}

const defaultRetry = (n: number) => Math.min(15_000, 1000 * 2 ** n);

/**
 * Everything the UI reads and writes, over loopback HTTP + the `/api/live` SSE stream. Framework-agnostic: each read is a
 * `Store` (the `useSyncExternalStore` contract), so React hooks in ./react.tsx are thin and other UIs can use it directly.
 * Live messages are only invalidations; the data always comes from a plain HTTP read.
 */
export class DorksClient {
  readonly api;
  private readonly cfg: ClientConfig;
  private readonly queries = new Map<string, Query<unknown>>();
  private readonly feeds = new Map<string, EventsFeed>();
  private closeLive: (() => void) | undefined;
  private connection: ConnectionState = { live: "connecting", unauthorized: false };
  private readonly connListeners = new Set<() => void>();
  private readonly qopts: QueryOptions;

  constructor(config: ClientConfig) {
    this.cfg = config;
    this.api = createApi(config);
    this.qopts = { retryDelay: config.retryDelay ?? defaultRetry, onUnauthorized: () => this.setConnection({ unauthorized: true }) };
  }

  /** Opens the live stream. Safe to call again after `close()`. */
  start() {
    if (this.closeLive) return;
    this.closeLive = connectLive({
      baseUrl: this.cfg.baseUrl,
      token: this.cfg.token,
      fetch: this.cfg.fetch,
      backoff: this.cfg.retryDelay,
      onStatus: (live) => this.setConnection({ live, ...(live === "unauthorized" ? { unauthorized: true } : {}) }),
      onMessage: (m) => this.onLive(m),
    });
  }

  close() {
    this.closeLive?.();
    this.closeLive = undefined;
  }

  readonly connectionStore: Store<ConnectionState> = {
    getSnapshot: () => this.connection,
    subscribe: (l) => {
      this.connListeners.add(l);
      return () => void this.connListeners.delete(l);
    },
  };

  private setConnection(patch: Partial<ConnectionState>) {
    const next = { ...this.connection, ...patch };
    if (next.live === this.connection.live && next.unauthorized === this.connection.unauthorized) return;
    this.connection = next;
    for (const l of [...this.connListeners]) l();
  }

  private query<T>(key: string, fetcher: () => Promise<T>): Query<T> {
    let q = this.queries.get(key) as Query<T> | undefined;
    if (!q) {
      q = new Query(fetcher, this.qopts);
      this.queries.set(key, q as Query<unknown>);
    }
    return q;
  }

  private invalidate(prefix: string) {
    for (const [key, q] of this.queries) if (key === prefix || key.startsWith(`${prefix}:`)) q.invalidate();
  }

  private onLive(m: LiveMessage) {
    switch (m.t) {
      case "hello":
        for (const q of this.queries.values()) q.invalidate();
        for (const f of this.feeds.values()) f.requestTail();
        break;
      case "dorks":
        this.invalidate("dorks");
        this.invalidate("automation-runs"); // a run names its session, its title and state
        break;
      case "dork":
        this.invalidate(`dork:${m.dorkId}`);
        break;
      case "events":
        this.feeds.get(m.dorkId)?.requestTail();
        break;
      case "comments":
        this.invalidate(`comments:${m.dorkId}`);
        break;
      case "subscriptions":
        this.invalidate(`subs:${m.dorkId}`);
        this.invalidate(`pr:${m.dorkId}`);
        break;
      case "settings":
        this.invalidate("settings");
        this.invalidate("pr"); // a new GitHub login may see a PR the old one could not
        this.invalidate("github-repos");
        this.invalidate("sentry-projects");
        this.invalidate("secrets");
        this.invalidate("mcp-servers");
        this.invalidate("skills");
        this.invalidate("composio");
        this.invalidate("local-access");
        this.invalidate("phone");
        break;
      case "snapshot":
        this.invalidate("snapshot");
        break;
      case "builds":
        this.invalidate("builds");
        break;
      case "build":
        this.invalidate(`build:${m.buildId}`);
        this.invalidate(`runs:${m.buildId}`);
        break;
      case "automations":
        this.invalidate("automations");
        this.invalidate("automation");
        this.invalidate("automation-runs");
        break;
    }
  }

  // ---- reads (stores) ----

  dorks(archived = false) {
    return this.query(`dorks:${archived}`, () => this.api.listDorks(archived));
  }

  /** `null` when the server says it does not exist. */
  dork(id: string) {
    return this.query<Dork | null>(`dork:${id}`, async () => {
      try {
        return await this.api.getDork(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    });
  }

  settings() {
    return this.query<Settings>("settings", () => this.api.getSettings());
  }

  /** The base-snapshot build ("Prepare Boat"). The live stream refreshes it at every step. */
  snapshot() {
    return this.query<SnapshotStatus>("snapshot", () => this.api.getSnapshot());
  }

  /** Claude subscription and Boat plan usage (the server caches it for a minute). `useUsage` refreshes it while the page is visible. */
  usage() {
    return this.query<Usage>("usage", () => this.api.getUsage());
  }

  /** Refetch usage now, if anything shows it. */
  refreshUsage() {
    this.invalidate("usage");
  }

  /** What the GitHub CLI's login can see (the server caches it briefly). Refetched when settings change. */
  githubRepos() {
    return this.query<GithubRepos>("github-repos", () => this.api.getGithubRepos());
  }

  secretNames() {
    return this.query<string[]>("secrets", () => this.api.listSecrets());
  }

  /** The connected Sentry organization's projects; `error` says why there are none. Refetched when settings change. */
  sentryProjects() {
    return this.query<SentryProjects>("sentry-projects", async () => {
      try {
        return await this.api.getSentryProjects();
      } catch (e) {
        if (e instanceof ApiError && e.code !== "forbidden") return { org: null, projects: [], error: e.message };
        throw e;
      }
    });
  }

  /** One of the session's pull requests (`url`; default its latest), live from GitHub; `null` when it has none. Refetched when the poller sees a PR change. */
  pullRequest(dorkId: string, url?: string) {
    return this.query<PullRequestView | null>(url ? `pr:${dorkId}:${url}` : `pr:${dorkId}`, async () => {
      try {
        return await this.api.getPullRequest(dorkId, url);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && e.code === "not_found") return null;
        throw e;
      }
    });
  }

  /** The MCP servers from Customize: names of headers and variables, never their values. */
  composio() {
    return this.query<ComposioStatus>("composio", () => this.api.composio());
  }
  /** Reads Composio again: a sign-in finishes in the browser, with no event here. */
  refreshComposio() {
    this.invalidate("composio");
  }
  /** Local access: the switch and the sessions allowed to use this computer (docs/local-access.md). */
  localAccess() {
    return this.query<LocalAccess>("local-access", () => this.api.localAccess());
  }

  /** The phone link: paired or not, the link's state and a pairing in progress. Refreshed with settings. */
  phone() {
    return this.query<PhoneStatus>("phone", () => this.api.phone());
  }
  mcpServers() {
    return this.query<McpServerView[]>("mcp-servers", () => this.api.listMcpServers());
  }
  /** The skills from Customize (docs/skills.md), shared by every sandbox. */
  skills() {
    return this.query<SkillView[]>("skills", () => this.api.listSkills());
  }

  /** The Files tab: the checkouts in the session's sandbox, and one checkout's files. Read again by `actions.refreshWorkspace`. */
  workspaceRoots(dorkId: string) {
    return this.query<{ roots: WorkspaceRoot[] }>(`workspace:${dorkId}`, () => this.api.workspaceRoots(dorkId));
  }
  workspaceTree(dorkId: string, root: string) {
    return this.query<WorkspaceTree>(`workspace:${dorkId}:${root}`, () => this.api.workspaceTree(dorkId, root));
  }

  subscriptions(dorkId: string) {
    return this.query<SubscriptionView[]>(`subs:${dorkId}`, () => this.api.listSubscriptions(dorkId));
  }

  /** The owner's comment threads on the session's running previews, and the agent's replies (oldest first). */
  comments(dorkId: string) {
    return this.query<CommentView[]>(`comments:${dorkId}`, () => this.api.listComments(dorkId));
  }

  events(dorkId: string): EventsFeed {
    let f = this.feeds.get(dorkId);
    if (!f) {
      const pageSize = this.cfg.pageSize ?? 40;
      f = new EventsFeed(this.api, dorkId, pageSize, this.qopts.onUnauthorized, this.qopts.retryDelay, this.cfg.olderPageSize ?? Math.max(pageSize, 150));
      this.feeds.set(dorkId, f);
    }
    return f;
  }

  /** Builds (docs/builds.md), refreshed by the live stream. */
  builds() {
    return this.query<BuildView[]>("builds", () => this.api.listBuilds());
  }

  /** `null` when it does not exist. */
  build(id: string) {
    return this.query<BuildView | null>(`build:${id}`, async () => {
      try {
        return await this.api.getBuild(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    });
  }

  runs(buildId: string) {
    return this.query<RunView[]>(`runs:${buildId}`, () => this.api.listRuns(buildId));
  }

  /** Automations (docs/automations.md), refreshed by the live stream. */
  automations() {
    return this.query<AutomationView[]>("automations", () => this.api.listAutomations());
  }

  /** `null` when it does not exist. */
  automation(id: string) {
    return this.query<AutomationView | null>(`automation:${id}`, async () => {
      try {
        return await this.api.getAutomation(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    });
  }

  automationRuns(id: string) {
    return this.query<AutomationRunView[]>(`automation-runs:${id}`, () => this.api.listAutomationRuns(id));
  }

  /** A run's redacted log from a byte offset (not cached: the caller tails it while the run is live). */
  runLog(buildId: string, runId: string, after = 0) {
    return this.api.runLog(buildId, runId, after);
  }

  // ---- writes: the API call, then an immediate refetch of what it changed (the live stream would do it too, a beat later) ----

  readonly actions = {
    createDork: async (input: CreateDorkInput) => {
      const r = await this.api.createDork(input);
      this.invalidate("dorks");
      return r;
    },
    renameDork: async (id: string, title: string) => {
      await this.api.renameDork(id, title);
      this.invalidate("dorks");
      this.invalidate(`dork:${id}`);
    },
    deleteDork: async (id: string) => {
      await this.api.deleteDork(id);
      this.invalidate("dorks");
      this.invalidate(`dork:${id}`);
    },
    archiveDork: async (id: string, archived: boolean) => {
      await this.api.setArchived(id, archived);
      this.invalidate("dorks");
      this.invalidate(`dork:${id}`);
    },
    interrupt: async (id: string) => {
      await this.api.interrupt(id);
      this.invalidate(`dork:${id}`);
    },
    /** Switches the session's mode (docs/modes.md); an awake agent restarts with it once its turn ends. */
    setMode: async (id: string, mode: DorkMode) => {
      await this.api.setMode(id, mode);
      this.invalidate(`dork:${id}`);
      this.invalidate("dorks");
    },
    chooseModel: async (id: string, model: string | null, effort: string | null, fast = false) => {
      await this.api.chooseModel(id, model, effort, fast);
      this.invalidate(`dork:${id}`);
    },
    /** A fresh live-view URL of the dork's computer, absolute (the simulator answers with a path on the server). Minted per view. */
    desktopUrl: async (id: string, opts: DesktopOptions) => {
      const { url } = await this.api.desktopUrl(id, opts);
      return new URL(url, `${this.cfg.baseUrl.replace(/\/+$/, "")}/`).toString();
    },
    /** Uploads an image for the message being written; resolves with its id. */
    uploadImage: async (image: Blob) => (await this.api.uploadImage(image)).id,
    /** The session's files matching `q`, best first (the composer's `@` menu). */
    /** Lists the sandbox's checkouts and their files again. */
    refreshWorkspace: (id: string) => this.invalidate(`workspace:${id}`),
    readWorkspaceFile: (id: string, root: string, path: string) => this.api.readWorkspaceFile(id, root, path),
    writeWorkspaceFile: async (id: string, root: string, path: string, contents: string, sha?: string) => {
      try {
        return await this.api.writeWorkspaceFile(id, root, path, contents, sha);
      } finally {
        this.invalidate(`workspace:${id}`); // its git status changed
      }
    },
    searchFiles: async (id: string, q: string) => (await this.api.searchFiles(id, q)).files,
    /** Where a shared screenshot (`dorks-image:<id>` in a message) loads from. The id is the capability: no token in the URL. */
    /** `width`: a smaller copy for showing it small (the server snaps it to a size it keeps; an older server sends the original). */
    imageUrl: (imageId: string, width?: number) => `${this.cfg.baseUrl.replace(/\/+$/, "")}/images/${encodeURIComponent(imageId)}${width ? `?w=${width}` : ""}`,
    chooseCodexModel: async (id: string, model: string, effort: string) => {
      await this.api.chooseCodexModel(id, model, effort);
      this.invalidate(`dork:${id}`);
    },
    /** Sends with an optimistic row; see EventsFeed.send. While the agent works the message steers its current turn. */
    sendMessage: (id: string, text: string) => this.events(id).send(text),
    /** Queues a message for when the agent's current turn ends (sent at once when none is running). Resolves whether it was queued. */
    queueMessage: async (id: string, text: string) => {
      const r = await this.api.queueMessage(id, text);
      this.invalidate(`dork:${id}`);
      if (!r.queued) this.events(id).requestTail();
      return r.queued;
    },
    /** Takes a message out of the queue; `send` sends it now instead, steering the running turn. */
    takeQueued: async (id: string, queuedId: string, send: boolean) => {
      await (send ? this.api.sendQueued(id, queuedId) : this.api.removeQueued(id, queuedId));
      this.invalidate(`dork:${id}`);
      if (send) this.events(id).requestTail();
    },
    addComment: async (id: string, input: NewComment) => {
      const r = await this.api.addComment(id, input);
      this.invalidate(`comments:${id}`);
      return r.id;
    },
    replyComment: async (id: string, commentId: string, body: string) => {
      await this.api.replyComment(id, commentId, body);
      this.invalidate(`comments:${id}`);
    },
    /** Edits the owner's own comment, or resolves / reopens a thread (its first comment). */
    changeComment: async (id: string, commentId: string, change: { body?: string; resolved?: boolean }) => {
      await this.api.changeComment(id, commentId, change);
      this.invalidate(`comments:${id}`);
    },
    deleteComment: async (id: string, commentId: string) => {
      await this.api.deleteComment(id, commentId);
      this.invalidate(`comments:${id}`);
    },
    subscribe: async (id: string, pr: PrRefInput) => {
      await this.api.subscribe(id, pr);
      this.invalidate(`subs:${id}`);
    },
    unsubscribe: async (id: string, pr: PrRefInput) => {
      await this.api.unsubscribe(id, pr);
      this.invalidate(`subs:${id}`);
    },
    resumeSubscription: async (id: string, pr: PrRefInput) => {
      await this.api.resumeSubscription(id, pr);
      this.invalidate(`subs:${id}`);
    },
    /** Reads the pull request from GitHub again. */
    refreshPullRequest: (id: string) => this.invalidate(`pr:${id}`),
    mergePullRequest: async (id: string, method: MergeMethod, sha?: string, url?: string) => {
      try {
        return await this.api.mergePullRequest(id, method, sha, url);
      } finally {
        this.invalidate(`pr:${id}`);
        this.invalidate(`dork:${id}`);
      }
    },
    markPullRequestReady: async (id: string, url?: string) => {
      try {
        await this.api.markPullRequestReady(id, url);
      } finally {
        this.invalidate(`pr:${id}`);
        this.invalidate(`subs:${id}`);
      }
    },
    updatePullRequestBranch: async (id: string, sha?: string, url?: string) => {
      try {
        await this.api.updatePullRequestBranch(id, sha, url);
      } finally {
        this.invalidate(`pr:${id}`);
      }
    },
    updateSettings: async (patch: SettingsPatch) => {
      await this.api.updateSettings(patch);
      this.invalidate("settings");
      if ("githubConnected" in patch) this.invalidate("github-repos");
    },
    /** Reads the GitHub CLI and GitHub again (after `gh auth refresh`, or granting it an organization) and refreshes `githubRepos()`. */
    refreshGithub: async () => {
      await this.api.getGithubRepos(true);
      this.invalidate("github-repos");
      this.invalidate("settings");
      this.invalidate("pr");
    },
    checkBoat: (input: { boatKey?: string; boatOrg?: string }) => this.api.checkBoat(input),
    /** Starts Antigravity's Google sign-in (services/antigravitySignIn.ts); resolves with its state, including Google's link. */
    signInAntigravity: async () => {
      try {
        return (await this.api.signInAntigravity()).antigravitySignIn;
      } finally {
        this.invalidate("settings");
      }
    },
    /** For a browser on another computer: the address the Google sign-in ended on, finished on the server's computer. */
    finishAntigravitySignIn: async (url: string) => {
      try {
        return (await this.api.finishAntigravitySignIn(url)).antigravitySignIn;
      } finally {
        this.invalidate("settings");
      }
    },
    /** Starts the Boat sign-in (services/boatSignIn.ts); resolves with its state, including the browser link to open. */
    signInBoat: async () => {
      try {
        return (await this.api.signInBoat()).boatSignIn;
      } finally {
        this.invalidate("settings");
      }
    },
    /** Starts "Prepare Boat". Resolves with the status right after it started; follow progress with `snapshot()` / `useSnapshot()`. */
    buildSnapshot: async (force = false) => {
      try {
        return await this.api.buildSnapshot(force);
      } finally {
        this.invalidate("snapshot");
        this.invalidate("settings");
      }
    },
    setSecret: async (name: string, value: string) => {
      await this.api.setSecret(name, value);
      this.invalidate("secrets");
    },
    deleteSecret: async (name: string) => {
      await this.api.deleteSecret(name);
      this.invalidate("secrets");
    },
    putMcpServer: async (name: string, input: McpServerInput) => {
      const r = await this.api.putMcpServer(name, input);
      this.invalidate("mcp-servers");
      return r;
    },
    connectComposio: async (apiKey: string) => {
      await this.api.connectComposio(apiKey);
      this.invalidate("mcp-servers");
      this.invalidate("composio");
    },
    disconnectComposio: async () => {
      await this.api.disconnectComposio();
      this.invalidate("mcp-servers");
      this.invalidate("composio");
    },
    composioLink: (toolkit: string) => this.api.composioLink(toolkit),
    mcpSignIn: (name: string) => this.api.mcpSignIn(name),
    mcpSignOut: async (name: string) => {
      await this.api.mcpSignOut(name);
      this.invalidate("mcp-servers");
    },
    composioUnlink: async (toolkit: string) => {
      await this.api.composioUnlink(toolkit);
      this.invalidate("composio");
    },
    /** The owner's answer to an agent's request to use this computer. The transcript shows the outcome. */
    /** The owner's answer to an agent's secure-input request. The transcript shows the outcome, never the values. */
    answerInput: async (dorkId: string, requestId: string, a: InputAnswer) => {
      await this.api.answerInput(dorkId, requestId, a);
    },
    decideLocal: async (dorkId: string, requestId: string, d: LocalDecision) => {
      await this.api.decideLocal(dorkId, requestId, d);
      this.invalidate("local-access");
      this.invalidate("settings"); // Always allow is a setting
    },
    setLocalAccess: async (enabled: boolean) => {
      await this.api.setLocalAccess(enabled);
      this.invalidate("local-access");
      this.invalidate("settings"); // turning it off also turns Always allow off
    },
    pairPhone: async (name?: string) => {
      const p = await this.api.pairPhone(name);
      this.invalidate("phone");
      return p;
    },
    cancelPhonePair: async () => {
      await this.api.cancelPhonePair();
      this.invalidate("phone");
    },
    unpairPhone: async () => {
      await this.api.unpairPhone();
      this.invalidate("phone");
    },
    /** Ends one session's permission to use this computer, or every session's. */
    revokeLocalSessions: async (dorkId?: string) => {
      await this.api.revokeLocalSessions(dorkId);
      this.invalidate("local-access");
    },
    deleteMcpServer: async (name: string) => {
      await this.api.deleteMcpServer(name);
      this.invalidate("mcp-servers");
    },
    resolveSkills: (source: string) => this.api.resolveSkills(source),
    installSkills: async (source: string, skills: string[]) => {
      const r = await this.api.installSkills(source, skills);
      this.invalidate("skills");
      return r;
    },
    updateSkill: async (name: string) => {
      const r = await this.api.updateSkill(name);
      this.invalidate("skills");
      return r;
    },
    deleteSkill: async (name: string) => {
      await this.api.deleteSkill(name);
      this.invalidate("skills");
    },
    createBuild: async (input: BuildInput & { name: string }) => {
      const r = await this.api.createBuild(input);
      this.invalidate("builds");
      return r;
    },
    updateBuild: async (id: string, patch: BuildInput) => {
      await this.api.updateBuild(id, patch);
      this.invalidateBuild(id);
    },
    deleteBuild: async (id: string) => {
      await this.api.deleteBuild(id);
      this.invalidateBuild(id);
      this.invalidate("settings");
    },
    setDefaultBuild: async (id: string, isDefault: boolean) => {
      await this.api.setDefaultBuild(id, isDefault);
      this.invalidateBuild(id);
      this.invalidate("settings");
    },
    setBuildVar: async (id: string, name: string, input: BuildVarInput) => {
      await this.api.setBuildVar(id, name, input);
      this.invalidateBuild(id);
    },
    deleteBuildVar: async (id: string, name: string) => {
      await this.api.deleteBuildVar(id, name);
      this.invalidateBuild(id);
    },
    startRun: async (id: string, kind: "image" | "trial") => {
      const r = await this.api.startRun(id, kind);
      this.invalidateBuild(id);
      return r;
    },
    cancelRun: async (id: string, runId: string) => {
      await this.api.cancelRun(id, runId);
      this.invalidateBuild(id);
    },
    approveDraft: async (id: string, draftId: string, reviewed: number, run = true) => {
      const r = await this.api.approveDraft(id, draftId, reviewed, run);
      this.invalidateBuild(id);
      return r;
    },
    rejectDraft: async (id: string, draftId: string, reason?: string) => {
      await this.api.rejectDraft(id, draftId, reason);
      this.invalidateBuild(id);
    },
    createAutomation: async (input: AutomationInput) => {
      const r = await this.api.createAutomation(input);
      this.invalidateAutomations();
      return r;
    },
    updateAutomation: async (id: string, patch: Partial<AutomationInput>) => {
      await this.api.updateAutomation(id, patch);
      this.invalidateAutomations();
    },
    deleteAutomation: async (id: string) => {
      await this.api.deleteAutomation(id);
      this.invalidateAutomations();
    },
    runAutomation: async (id: string) => {
      const r = await this.api.runAutomation(id);
      this.invalidateAutomations();
      this.invalidate("dorks");
      return r;
    },
  };

  private invalidateAutomations() {
    this.invalidate("automations");
    this.invalidate("automation");
    this.invalidate("automation-runs");
  }

  private invalidateBuild(id: string) {
    this.invalidate("builds");
    this.invalidate(`build:${id}`);
    this.invalidate(`runs:${id}`);
  }
}

export function createClient(config: ClientConfig): DorksClient {
  return new DorksClient(config);
}
