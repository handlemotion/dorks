import { appError, type AppError, type AppErrorCode, type SubscriptionView } from "@dorks/shared";
import type { CreateDorkInput, Dork, EventsPage, PrRefInput, Settings, SettingsPatch, SnapshotStatus } from "./types.ts";

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
        headers: { authorization: `Bearer ${config.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
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
    interrupt: (id: string) => request<object>("POST", `${dork(id)}/interrupt`),
    setArchived: (id: string, archived: boolean) => request<object>("POST", `${dork(id)}/archive`, { archived }),
    chooseCodexModel: (id: string, model: string, effort: string) => request<object>("POST", `${dork(id)}/codex-model`, { model, effort }),
    /** Newest first with `before` (or neither); ascending with `after` (everything with seq > after). */
    events: (id: string, q: { before?: number; after?: number; limit?: number } = {}) => request<EventsPage>("GET", `${dork(id)}/events`, undefined, q),
    listSubscriptions: (id: string) => request<SubscriptionView[]>("GET", `${dork(id)}/subscriptions`),
    subscribe: (id: string, pr: PrRefInput) => request<object>("POST", `${dork(id)}/subscriptions`, pr),
    unsubscribe: (id: string, pr: PrRefInput) => request<object>("DELETE", `${dork(id)}/subscriptions`, pr),
    resumeSubscription: (id: string, pr: PrRefInput) => request<object>("POST", `${dork(id)}/subscriptions/resume`, pr),
    getSettings: () => request<Settings>("GET", "/api/settings"),
    updateSettings: (patch: SettingsPatch) => request<object>("PUT", "/api/settings", patch),
    getSnapshot: () => request<SnapshotStatus>("GET", "/api/snapshot"),
    /** Starts the build (idempotent: returns the current status if one is running or the snapshot is current). */
    buildSnapshot: (force = false) => request<SnapshotStatus>("POST", "/api/snapshot/build", force ? { force: true } : {}),
    listSecrets: () => request<string[]>("GET", "/api/secrets"),
    setSecret: (name: string, value: string) => request<object>("PUT", `/api/secrets/${enc(name)}`, { value }),
    deleteSecret: (name: string) => request<object>("DELETE", `/api/secrets/${enc(name)}`),
  };
}
