// Ported from handlemotion/dorks-cloud src/realtime @ df775f3 (s2.ts), unchanged apart from this line: keep the two in step.
// A small s2.dev REST client (https://s2.dev/docs/api/protocol): fetch only, so it runs in the Worker, in Node (the bridge, the
// e2e script) and in clients. Record headers and bodies are UTF-8 strings (`s2-format: raw`); everything we write is JSON text.

export type S2Config = {
  token: string;
  basin: string;
  /** Default https://a.s2.dev/v1 */
  accountUrl?: string;
  /** Default https://{basin}.b.s2.dev/v1; "{basin}" is replaced. */
  basinUrl?: string;
  fetch?: typeof fetch;
  /** Base64 32-byte key for streams created under a basin with a `stream_cipher` (sent as s2-encryption-key on appends and reads). */
  encryptionKey?: string;
};

export type Position = { seq_num: number; timestamp: number };
export type AppendRecord = { headers?: [string, string][]; body?: string; timestamp?: number };
export type SequencedRecord = { seq_num: number; timestamp: number; headers?: [string, string][]; body?: string };
export type AppendAck = { start: Position; end: Position; tail: Position };
export type ReadBatch = { records: SequencedRecord[]; tail?: Position | null };

export type StreamConfig = {
  storage_class?: "standard" | "express" | null;
  retention_policy?: { age: number } | { infinite: Record<string, never> } | null;
  delete_on_empty?: { min_age_secs: number } | null;
  timestamping?: { mode?: "client-prefer" | "client-require" | "arrival"; uncapped?: boolean } | null;
};

export type Op =
  | "list-streams"
  | "create-stream"
  | "delete-stream"
  | "get-stream-config"
  | "reconfigure-stream"
  | "check-tail"
  | "append"
  | "read"
  | "trim"
  | "fence"
  | "issue-access-token"
  | "revoke-access-token"
  | "list-access-tokens"
  | "list-basins"
  | "create-basin"
  | "delete-basin"
  | "reconfigure-basin"
  | "get-basin-config";
export type ResourceSet = { exact: string } | { prefix: string };
export type TokenScope = {
  basins?: ResourceSet | null;
  streams?: ResourceSet | null;
  access_tokens?: ResourceSet | null;
  ops?: Op[];
};

/** A non-2xx answer. `body` is the parsed JSON (412: {fencing_token_mismatch} | {seq_num_mismatch}; 416: {tail}). */
export class S2Error extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: any;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** https://s2.dev/docs/api/error-codes: worth retrying (with backoff). 412/416 never are. */
  get retryable() {
    return this.status === 408 || this.status === 429 || this.status >= 500 || this.code === "transaction_conflict";
  }
  /** The token is unknown, expired or revoked (401), or lacks the scope (403). */
  get unauthorized() {
    return this.status === 401 || (this.status === 403 && this.code === "permission_denied");
  }
}

const enc = encodeURIComponent;

/** How long one s2 call may take, beyond a long poll's `wait`. */
const REQUEST_TIMEOUT_MS = 30_000;

export class S2 {
  readonly cfg: S2Config;
  constructor(cfg: S2Config) {
    this.cfg = cfg;
  }
  get basin() {
    return this.cfg.basin;
  }
  get accountUrl() {
    return (this.cfg.accountUrl || "https://a.s2.dev/v1").replace(/\/$/, "");
  }
  get basinUrl() {
    return (this.cfg.basinUrl || "https://{basin}.b.s2.dev/v1").replace("{basin}", this.cfg.basin).replace(/\/$/, "");
  }
  /** The same account and basin with another token (e.g. a scoped one just issued). */
  withToken(token: string) {
    return new S2({ ...this.cfg, token });
  }
  /** The same client with another (or no) stream encryption key. */
  withKey(encryptionKey: string | undefined) {
    return new S2({ ...this.cfg, encryptionKey });
  }
  recordsUrl(stream: string) {
    return `${this.basinUrl}/streams/${enc(stream)}/records`;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const f = this.cfg.fetch ?? fetch;
    // A half-open connection must not hold an append or the command tail for minutes: every call gets a deadline (a long poll's
    // own `wait` plus margin, passed in by the caller), on top of the caller's stop signal.
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS + (Number(new URL(url).searchParams.get("wait")) || 0) * 1000);
    const res = await f(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        "content-type": "application/json",
        "s2-format": "raw",
        ...(this.cfg.encryptionKey && url.startsWith(this.basinUrl) ? { "s2-encryption-key": this.cfg.encryptionKey } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: any = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const code = (body && typeof body === "object" && typeof body.code === "string" && body.code) || `http_${res.status}`;
      const message = (body && typeof body === "object" && body.message) || (typeof body === "string" ? body.slice(0, 200) : "");
      throw new S2Error(res.status, code, `s2 ${init.method ?? "GET"} ${new URL(url).pathname}: ${res.status} ${code} ${message}`.trim(), body);
    }
    return body as T;
  }

  // --- access tokens (account endpoint) ---

  async issueToken(id: string, scope: TokenScope, expiresAt: Date): Promise<string> {
    const r = await this.request<{ access_token: string }>(`${this.accountUrl}/access-tokens`, {
      method: "POST",
      body: JSON.stringify({ id, scope, expires_at: expiresAt.toISOString() }),
    });
    return r.access_token;
  }

  async revokeToken(id: string) {
    try {
      await this.request(`${this.accountUrl}/access-tokens/${enc(id)}`, { method: "DELETE" });
      return true;
    } catch (e) {
      if (e instanceof S2Error && e.status === 404) return false; // already gone (or expired and collected)
      throw e;
    }
  }

  async listTokens(prefix: string) {
    const ids: { id: string; expires_at?: string | null; scope: TokenScope }[] = [];
    let after = "";
    for (;;) {
      const r = await this.request<{ access_tokens: { id: string; expires_at?: string | null; scope: TokenScope }[]; has_more: boolean }>(
        `${this.accountUrl}/access-tokens?prefix=${enc(prefix)}&start_after=${enc(after)}&limit=1000`,
      );
      ids.push(...r.access_tokens);
      if (!r.has_more || !r.access_tokens.length) return ids;
      after = r.access_tokens[r.access_tokens.length - 1].id;
    }
  }

  // --- basins (account endpoint): used by scripts, not by the Worker ---

  ensureBasin(config: Record<string, unknown>) {
    return this.request(`${this.accountUrl}/basins/${enc(this.basin)}`, { method: "PUT", body: JSON.stringify({ config }) });
  }
  async deleteBasin() {
    try {
      await this.request(`${this.accountUrl}/basins/${enc(this.basin)}`, { method: "DELETE" });
    } catch (e) {
      if (!(e instanceof S2Error && e.status === 404)) throw e;
    }
  }

  // --- streams (basin endpoint) ---

  /** Creates the stream, or sets its config if it exists (PUT, idempotent). */
  ensureStream(stream: string, config: StreamConfig) {
    return this.request(`${this.basinUrl}/streams/${enc(stream)}`, { method: "PUT", body: JSON.stringify(config) });
  }

  /** Deletion is asynchronous on s2's side: the name stays taken for a few minutes. Missing streams count as deleted. */
  async deleteStream(stream: string) {
    try {
      await this.request(`${this.basinUrl}/streams/${enc(stream)}`, { method: "DELETE" });
      return true;
    } catch (e) {
      if (e instanceof S2Error && (e.status === 404 || e.code === "stream_deletion_pending")) return false;
      throw e;
    }
  }

  async listStreams(prefix: string) {
    const names: string[] = [];
    let after = "";
    for (;;) {
      const r = await this.request<{ streams: { name: string; deleted_at?: string | null }[]; has_more: boolean }>(
        `${this.basinUrl}/streams?prefix=${enc(prefix)}&start_after=${enc(after)}&limit=1000`,
      );
      names.push(...r.streams.filter((s) => !s.deleted_at).map((s) => s.name));
      if (!r.has_more || !r.streams.length) return names;
      after = r.streams[r.streams.length - 1].name;
    }
  }

  // --- records (basin endpoint) ---

  append(stream: string, records: AppendRecord[], cond: { matchSeqNum?: number; fencingToken?: string } = {}) {
    const body: Record<string, unknown> = { records };
    if (cond.matchSeqNum !== undefined) body.match_seq_num = cond.matchSeqNum;
    if (cond.fencingToken !== undefined) body.fencing_token = cond.fencingToken;
    return this.request<AppendAck>(this.recordsUrl(stream), { method: "POST", body: JSON.stringify(body) });
  }

  /** One unary read. Returns an empty batch (with the tail) where s2 answers 416 (nothing at or after the start). */
  async read(
    stream: string,
    from: { seqNum: number } | { tailOffset: number },
    opts: { count?: number; bytes?: number; wait?: number; clamp?: boolean; signal?: AbortSignal } = {},
  ): Promise<ReadBatch> {
    const q = new URLSearchParams();
    if ("seqNum" in from) q.set("seq_num", String(from.seqNum));
    else q.set("tail_offset", String(from.tailOffset));
    if (opts.count !== undefined) q.set("count", String(opts.count));
    if (opts.bytes !== undefined) q.set("bytes", String(opts.bytes));
    if (opts.wait !== undefined) q.set("wait", String(opts.wait));
    if (opts.clamp) q.set("clamp", "true");
    try {
      return await this.request<ReadBatch>(`${this.recordsUrl(stream)}?${q}`, { signal: opts.signal });
    } catch (e) {
      if (e instanceof S2Error && e.status === 416) return { records: [], tail: e.body?.tail ?? null };
      throw e;
    }
  }

  async checkTail(stream: string): Promise<Position> {
    return (await this.request<{ tail: Position }>(`${this.recordsUrl(stream)}/tail`)).tail;
  }

  /** Sets the stream's fencing token (a `fence` command record; needs the `fence` op). Later appends carrying another token get 412. */
  fence(stream: string, token: string, cond: { fencingToken?: string } = {}) {
    if (new TextEncoder().encode(token).length > 36) throw new Error("s2 fencing tokens are at most 36 bytes");
    return this.append(stream, [{ headers: [["", "fence"]], body: token }], cond);
  }
}

/** A command record (fence, trim) is one header with an empty name: https://s2.dev/docs/concepts/command-records */
export const isCommandRecord = (r: { headers?: [string, string][] }) => r.headers?.length === 1 && r.headers[0][0] === "";
