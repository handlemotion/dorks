import {
  appError,
  type AppError,
  type AppErrorCode,
  type AutomationInput,
  type AutomationRunView,
  type AutomationView,
  type CommentAnchor,
  type CommentView,
  type ComposioStatus,
  type DorkMode,
  type McpOAuthState,
  type McpServerInput,
  type McpServerView,
  type MergeMethod,
  type PullRequestView,
  type SkillResolution,
  type SkillView,
  type SubscriptionView,
  type WorkspaceFile,
  type WorkspaceRoot,
  type WorkspaceTree,
} from "@dorks/shared";
import type {
  BoatCheck,
  AntigravitySignIn,
  BoatSignIn,
  BuildInput,
  BuildVarInput,
  BuildView,
  CreateDorkInput,
  Dork,
  EventsPage,
  Me,
  PrRefInput,
  RunLog,
  RunView,
  Settings,
  LocalAccess,
  LocalDecision,
  PhonePairing,
  PhoneStatus,
  CloudOrg,
  CloudPlaces,
  CloudStatus,
  InputAnswer,
  SettingsPatch,
  SnapshotStatus,
  Usage,
  GithubRepos,
  SentryProjects,
} from "./types.ts";

/** A new comment thread on a running preview: where it points and the preview's port. */
export interface NewComment {
  body: string;
  anchor: CommentAnchor;
  /** The preview's port; none for a comment on an image. */
  port?: number;
}

/**
 * Thrown for every failed call. `data` is the typed AppError, so `toAppError(e)` from @dorks/shared reads it unchanged
 * (the way errors have always been read), and `message` is always safe to show.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly data: AppError;
  constructor(status: number, data: AppError) {
    super(data.message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
  get code(): AppErrorCode {
    return this.data.code;
  }
}

const NETWORK: AppError = { code: "failed", message: "Cannot reach the dorks server. Is it running?" };

function errorFromStatus(status: number): AppError {
  if (status === 401) return { code: "forbidden", message: "The owner token was rejected." };
  if (status === 404) return { code: "not_found", message: "Not found." };
  return { code: "failed", message: `Request failed (${status}).` };
}

export interface ApiConfig {
  /** Origin of the UI listener, e.g. `http://127.0.0.1:4747`. */
  baseUrl: string;
  /** Owner bearer token. */
  token: string;
  fetch?: typeof fetch;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(config: ApiConfig) {
  const base = config.baseUrl.replace(/\/+$/, "");
  const doFetch = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          ...(body instanceof Blob ? { "content-type": body.type || "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, NETWORK);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = appError.safeParse((json as { error?: unknown } | undefined)?.error);
      throw new ApiError(res.status, parsed.success ? parsed.data : errorFromStatus(res.status));
    }
    return json as T;
  }

  const enc = encodeURIComponent;
  const dork = (id: string) => `/api/dorks/${enc(id)}`;

  return {
    /** The one unauthenticated endpoint; use it to tell "server down" from "bad token". */
    async health(): Promise<boolean> {
      try {
        return (await doFetch(`${base}/api/health`)).ok;
      } catch {
        return false;
      }
    },
    listDorks: (archived = false) => request<Dork[]>("GET", "/api/dorks", undefined, { archived: archived ? true : undefined }),
    getDork: (id: string) => request<Dork>("GET", dork(id)),
    createDork: (input: CreateDorkInput) => request<{ id: string }>("POST", "/api/dorks", input),
    renameDork: (id: string, title: string) => request<object>("PATCH", dork(id), { title }),
    deleteDork: (id: string) => request<object>("DELETE", dork(id)),
    sendMessage: (id: string, text: string) => request<object>("POST", `${dork(id)}/messages`, { text }),
    /** Queues a message for when the current turn ends; sent at once (`queued: false`) when no turn is running. */
    queueMessage: (id: string, text: string) => request<{ queued: boolean }>("POST", `${dork(id)}/queue`, { text }),
    removeQueued: (id: string, queuedId: string) => request<object>("DELETE", `${dork(id)}/queue/${enc(queuedId)}`),
    sendQueued: (id: string, queuedId: string) => request<object>("POST", `${dork(id)}/queue/${enc(queuedId)}/send`),
    interrupt: (id: string) => request<object>("POST", `${dork(id)}/interrupt`),
    /** A fresh live-view URL of the dork's computer; a bearer credential, so never cache or log it. */
    /** Uploads an image to attach to a message; the message names it as `![name](dorks-image:<id>)`. */
    uploadImage: (image: Blob) => request<{ id: string }>("POST", "/api/images", image),
    desktopUrl: (id: string, opts: DesktopOptions) => request<{ url: string }>("POST", `${dork(id)}/desktop`, opts),
    /** The owner read the chat: it stops showing as unread on every device. */
    markRead: (id: string) => request<object>("POST", `${dork(id)}/read`),
    /** Who this client is to the server (docs/cloud.md). */
    me: () => request<Me>("GET", "/api/me"),
    /** This client (a tab or a phone, `client` its id) now shows `dorkId`; null: no dork. */
    setPresence: (client: string, dorkId: string | null) => request<object>("POST", "/api/presence", { client, dorkId }),
    setArchived: (id: string, archived: boolean) => request<object>("POST", `${dork(id)}/archive`, { archived }),
    /** Claude: `model` null for the agent's default, `effort` null for the model's default, `fast` for fast mode. */
    setMode: (id: string, mode: DorkMode) => request<object>("POST", `${dork(id)}/mode`, { mode }),
    chooseModel: (id: string, model: string | null, effort: string | null, fast = false) => request<object>("POST", `${dork(id)}/model`, { model, effort, fast }),
    chooseCodexModel: (id: string, model: string, effort: string) => request<object>("POST", `${dork(id)}/codex-model`, { model, effort }),
    /** Newest first with `before` (or neither); ascending with `after` (everything with seq > after). */
    events: (id: string, q: { before?: number; after?: number; limit?: number } = {}) => request<EventsPage>("GET", `${dork(id)}/events`, undefined, q),
    listSubscriptions: (id: string) => request<SubscriptionView[]>("GET", `${dork(id)}/subscriptions`),
    subscribe: (id: string, pr: PrRefInput) => request<object>("POST", `${dork(id)}/subscriptions`, pr),
    unsubscribe: (id: string, pr: PrRefInput) => request<object>("DELETE", `${dork(id)}/subscriptions`, pr),
    resumeSubscription: (id: string, pr: PrRefInput) => request<object>("POST", `${dork(id)}/subscriptions/resume`, pr),
    /** The session's files that match `q`, best first, for the composer's `@` menu; `listed` is false until its box has listed them. */
    /** The Files tab: the git checkouts in the session's sandbox (409 `sleeping` while it is asleep). */
    workspaceRoots: (id: string) => request<{ roots: WorkspaceRoot[] }>("GET", `${dork(id)}/workspace`),
    workspaceTree: (id: string, root: string) => request<WorkspaceTree>("GET", `${dork(id)}/workspace/tree`, undefined, { root }),
    readWorkspaceFile: (id: string, root: string, path: string) => request<WorkspaceFile>("GET", `${dork(id)}/workspace/file`, undefined, { root, path }),
    /** Saves a file; `sha` is the version it was edited from (409 `conflict` when the sandbox has another). */
    writeWorkspaceFile: (id: string, root: string, path: string, contents: string, sha?: string) =>
      request<{ sha: string; size: number }>("PUT", `${dork(id)}/workspace/file`, { root, path, contents, sha }),
    searchFiles: (id: string, q: string, limit = 50) => request<{ files: string[]; listed: boolean; truncated: boolean }>("GET", `${dork(id)}/files`, undefined, { q, limit }),
    listComments: (id: string) => request<CommentView[]>("GET", `${dork(id)}/comments`),
    addComment: (id: string, input: NewComment) => request<{ id: string }>("POST", `${dork(id)}/comments`, input),
    replyComment: (id: string, commentId: string, body: string) => request<{ id: string }>("POST", `${dork(id)}/comments/${encodeURIComponent(commentId)}/replies`, { body }),
    changeComment: (id: string, commentId: string, change: { body?: string; resolved?: boolean }) => request<object>("PATCH", `${dork(id)}/comments/${encodeURIComponent(commentId)}`, change),
    deleteComment: (id: string, commentId: string) => request<object>("DELETE", `${dork(id)}/comments/${encodeURIComponent(commentId)}`),
    /** The session's pull request, read live from GitHub (404 `not_found` when the session has none). */
    /** One of the session's pull requests by `url` (a PR it opened or follows), else its latest. */
    getPullRequest: (id: string, url?: string) => request<PullRequestView>("GET", `${dork(id)}/pr${url ? `?url=${enc(url)}` : ""}`),
    /** Merges it; `sha` pins the head that was reviewed (a newer push answers 409 `conflict`). */
    mergePullRequest: (id: string, method: MergeMethod, sha?: string, url?: string) =>
      request<{ merged: true; sha?: string } | { merged: false; queued: true }>("POST", `${dork(id)}/pr/merge`, { method, sha, url }),
    /** Marks a draft pull request ready for review. */
    markPullRequestReady: (id: string, url?: string) => request<object>("POST", `${dork(id)}/pr/ready`, { url }),
    /** Merges the base branch into the PR's branch (GitHub's "Update branch"). */
    updatePullRequestBranch: (id: string, sha?: string, url?: string) => request<object>("POST", `${dork(id)}/pr/update-branch`, { sha, url }),
    getSettings: () => request<Settings>("GET", "/api/settings"),
    decideLocal: (id: string, requestId: string, d: LocalDecision) => request<object>("POST", `${dork(id)}/local/${enc(requestId)}`, d),
    /** Sends the values the owner typed (or a dismissal). The answer never echoes them. */
    answerInput: (id: string, requestId: string, a: InputAnswer) => request<object>("POST", `${dork(id)}/inputs/${enc(requestId)}`, a),
    localAccess: () => request<LocalAccess>("GET", "/api/local-access"),
    phone: () => request<PhoneStatus>("GET", "/api/phone"),
    /** Starts pairing with the iPhone app: a code and a QR link, valid for 10 minutes. */
    pairPhone: (name?: string) => request<PhonePairing>("POST", "/api/phone/pair", name ? { name } : {}),
    cancelPhonePair: () => request<object>("DELETE", "/api/phone/pair"),
    unpairPhone: () => request<object>("DELETE", "/api/phone"),
    /** The Dorks Cloud account this server is signed in to (docs/mobile.md, "Desktop: Dorks Cloud"). */
    cloud: () => request<CloudStatus>("GET", "/api/cloud"),
    cloudSendCode: (email: string) => request<object>("POST", "/api/cloud/sign-in/email", { email }),
    cloudVerify: (email: string, code: string) => request<CloudStatus>("POST", "/api/cloud/sign-in/verify", { email, code }),
    cloudSignOut: () => request<object>("DELETE", "/api/cloud/session"),
    cloudPlaces: () => request<CloudPlaces>("GET", "/api/cloud/places"),
    cloudCreateOrg: (name: string) => request<CloudOrg>("POST", "/api/cloud/orgs", { name }),
    setLocalAccess: (enabled: boolean) => request<object>("PUT", "/api/local-access", { enabled }),
    revokeLocalSessions: (dorkId?: string) => request<object>("DELETE", dorkId ? `/api/local-access/sessions?dork=${enc(dorkId)}` : "/api/local-access/sessions"),
    updateSettings: (patch: SettingsPatch) => request<object>("PUT", "/api/settings", patch),
    /** Checks the given key (or the saved one) against Boat without saving it. */
    checkBoat: (input: { boatKey?: string; boatOrg?: string }) => request<BoatCheck>("POST", "/api/boat/check", input),
    /** Connects Boat with the Boat CLI: at once when it is signed in, else returns the browser sign-in link to open. */
    signInBoat: () => request<{ boatSignIn: BoatSignIn | null }>("POST", "/api/boat/sign-in", {}),
    signInAntigravity: () => request<{ antigravitySignIn: AntigravitySignIn | null }>("POST", "/api/antigravity/sign-in", {}),
    finishAntigravitySignIn: (url: string) => request<{ antigravitySignIn: AntigravitySignIn | null }>("POST", "/api/antigravity/sign-in/finish", { url }),
    getSnapshot: () => request<SnapshotStatus>("GET", "/api/snapshot"),
    /** Starts the build (idempotent: returns the current status if one is running or the snapshot is current). */
    buildSnapshot: (force = false) => request<SnapshotStatus>("POST", "/api/snapshot/build", force ? { force: true } : {}),
    getUsage: () => request<Usage>("GET", "/api/usage"),
    /** `fresh`: read the GitHub CLI and GitHub again instead of the server's short cache. */
    getSentryProjects: () => request<SentryProjects>("GET", "/api/sentry/projects"),
    getGithubRepos: (fresh = false) => request<GithubRepos>("GET", fresh ? "/api/github/repos?fresh=1" : "/api/github/repos"),
    listSecrets: () => request<string[]>("GET", "/api/secrets"),
    setSecret: (name: string, value: string) => request<object>("PUT", `/api/secrets/${enc(name)}`, { value }),
    deleteSecret: (name: string) => request<object>("DELETE", `/api/secrets/${enc(name)}`),
    listMcpServers: () => request<McpServerView[]>("GET", "/api/mcp-servers"),
    putMcpServer: (name: string, input: McpServerInput) => request<{ oauth?: McpOAuthState | null }>("PUT", `/api/mcp-servers/${enc(name)}`, input),
    deleteMcpServer: (name: string) => request<object>("DELETE", `/api/mcp-servers/${enc(name)}`),
    listSkills: () => request<SkillView[]>("GET", "/api/skills"),
    resolveSkills: (source: string) => request<SkillResolution>("POST", "/api/skills/resolve", { source }),
    installSkills: (source: string, skills: string[]) => request<{ installed: string[] }>("POST", "/api/skills", { source, skills }),
    updateSkill: (name: string) => request<{ updated: boolean }>("POST", `/api/skills/${enc(name)}/update`),
    deleteSkill: (name: string) => request<object>("DELETE", `/api/skills/${enc(name)}`),
    /** A sign-in page for an OAuth server; the browser comes back to this server, so it sends the URL it reaches it at. */
    mcpSignIn: (name: string) => request<{ url: string }>("POST", `/api/mcp-servers/${enc(name)}/oauth`, { base: new URL(base || "/", globalThis.location?.href).origin }),
    mcpSignOut: (name: string) => request<object>("DELETE", `/api/mcp-servers/${enc(name)}/oauth`),
    composio: () => request<ComposioStatus>("GET", "/api/composio"),
    connectComposio: (apiKey: string) => request<object>("PUT", "/api/composio", { apiKey }),
    disconnectComposio: () => request<object>("DELETE", "/api/composio"),
    composioLink: (toolkit: string) => request<{ url: string }>("POST", `/api/composio/toolkits/${enc(toolkit)}/link`),
    composioUnlink: (toolkit: string) => request<object>("DELETE", `/api/composio/toolkits/${enc(toolkit)}`),
    // builds (docs/builds.md)
    listBuilds: () => request<BuildView[]>("GET", "/api/builds"),
    getBuild: (id: string) => request<BuildView>("GET", `/api/builds/${enc(id)}`),
    createBuild: (input: BuildInput & { name: string }) => request<{ id: string }>("POST", "/api/builds", input),
    updateBuild: (id: string, patch: BuildInput) => request<object>("PATCH", `/api/builds/${enc(id)}`, patch),
    deleteBuild: (id: string) => request<object>("DELETE", `/api/builds/${enc(id)}`),
    setDefaultBuild: (id: string, isDefault: boolean) => request<object>("PUT", `/api/builds/${enc(id)}/default`, { default: isDefault }),
    setBuildVar: (id: string, name: string, input: BuildVarInput) => request<object>("PUT", `/api/builds/${enc(id)}/vars/${enc(name)}`, input),
    deleteBuildVar: (id: string, name: string) => request<object>("DELETE", `/api/builds/${enc(id)}/vars/${enc(name)}`),
    listRuns: (id: string) => request<RunView[]>("GET", `/api/builds/${enc(id)}/runs`),
    startRun: (id: string, kind: "image" | "trial") => request<RunView>("POST", `/api/builds/${enc(id)}/runs`, { kind }),
    runLog: (id: string, runId: string, after = 0) => request<RunLog>("GET", `/api/builds/${enc(id)}/runs/${enc(runId)}/log`, undefined, { after }),
    cancelRun: (id: string, runId: string) => request<object>("POST", `/api/builds/${enc(id)}/runs/${enc(runId)}/cancel`),
    /** `reviewed`: the `updatedAt` of the draft the owner saw; a draft changed since is refused with `conflict`. */
    approveDraft: (id: string, draftId: string, reviewed: number, run = true) =>
      request<{ run: RunView | null; missing: string[] }>("POST", `/api/builds/${enc(id)}/drafts/${enc(draftId)}/approve`, { reviewed, run }),
    rejectDraft: (id: string, draftId: string, reason?: string) => request<object>("POST", `/api/builds/${enc(id)}/drafts/${enc(draftId)}/reject`, { reason }),
    // automations (docs/automations.md)
    listAutomations: () => request<AutomationView[]>("GET", "/api/automations"),
    getAutomation: (id: string) => request<AutomationView>("GET", `/api/automations/${enc(id)}`),
    createAutomation: (input: AutomationInput) => request<{ id: string }>("POST", "/api/automations", input),
    /** Merged over the saved definition: `{enabled}` alone pauses or resumes it. */
    updateAutomation: (id: string, patch: Partial<AutomationInput>) => request<object>("PATCH", `/api/automations/${enc(id)}`, patch),
    deleteAutomation: (id: string) => request<object>("DELETE", `/api/automations/${enc(id)}`),
    listAutomationRuns: (id: string) => request<AutomationRunView[]>("GET", `/api/automations/${enc(id)}/runs`),
    runAutomation: (id: string) => request<AutomationRunView>("POST", `/api/automations/${enc(id)}/runs`),
  };
}

export type DesktopOptions = { theme: "light" | "dark" };
