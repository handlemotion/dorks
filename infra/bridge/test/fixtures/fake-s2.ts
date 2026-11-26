// Ported from handlemotion/dorks-cloud test/realtime/fake-s2.ts @ df775f3.
// An in-memory s2 (the subset src/realtime uses), as a fetch function, for CI: scoped and expiring tokens, fencing,
// match_seq_num, unary and SSE reads, stream and token listing. It follows the documented semantics
// (https://s2.dev/docs/api); test/s2-live.test.ts checks the bridge against the real s2.

type Rec = { seq_num: number; timestamp: number; headers: [string, string][]; body: string };
type Stream = { records: Rec[]; fence: string; config: unknown; waiters: Set<() => void>; cipher: boolean; keys: string[] };
type Scope = { basins?: Match | null; streams?: Match | null; access_tokens?: Match | null; ops?: string[] };
type Match = { exact: string } | { prefix: string };
type Token = { id: string; secret: string; scope: Scope; expiresAt: number; revoked: boolean };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, message = code) => json(status, { code, message });
const matches = (m: Match | null | undefined, name: string) => !!m && ("exact" in m ? m.exact === name : name.startsWith(m.prefix));

const isFenceRecord = (r: { headers?: [string, string][] }) => r.headers?.length === 1 && r.headers[0][0] === "" && r.headers[0][1] === "fence";

export const ROOT = "root-token";
const isCmd = (r: Rec) => r.headers.length === 1 && r.headers[0][0] === "";
export const ACCOUNT_URL = "http://s2.fake/account/v1";
export const BASIN_URL = "http://s2.fake/basin/{basin}/v1";

export class FakeS2 {
  streams = new Map<string, Stream>(); // key: basin/stream
  tokens = new Map<string, Token>(); // by secret
  now = () => Date.now();
  /** Fault injection: the next append to a stream with this name is applied, but its response is lost (a network error). */
  loseNextAck = new Set<string>();
  appends = 0;
  /** Basins with a stream_cipher: their new streams need s2-encryption-key on appends and reads. */
  ciphers = new Set<string>();

  constructor() {
    this.tokens.set(ROOT, { id: "root", secret: ROOT, scope: { basins: { prefix: "" }, streams: { prefix: "" }, access_tokens: { prefix: "" }, ops: ["*"] }, expiresAt: Infinity, revoked: false });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const auth = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const tok = this.tokens.get(auth);
    if (!tok || tok.revoked || tok.expiresAt <= this.now()) return err(401, "authn", "invalid or expired token");
    const can = (op: string) => tok.scope.ops?.includes("*") || tok.scope.ops?.includes(op);
    const path = url.pathname;

    if (path.startsWith("/account/v1/access-tokens")) return this.account(req, url, tok, can);
    return this.basin(req, url, tok, can);
  };

  private async account(req: Request, url: URL, tok: Token, can: (op: string) => boolean | undefined): Promise<Response> {
    const path = url.pathname;
    const id = decodeURIComponent(path.slice("/account/v1/access-tokens/".length));
    if (req.method === "POST") {
      if (!can("issue-access-token")) return err(403, "permission_denied");
      const body = (await req.json()) as { id: string; scope: Scope; expires_at?: string };
      if (!matches(tok.scope.access_tokens, body.id)) return err(403, "permission_denied");
      if ([...this.tokens.values()].some((t) => t.id === body.id)) return err(409, "resource_already_exists");
      const secret = "tok_" + crypto.randomUUID();
      const expiresAt = Math.min(tok.expiresAt, body.expires_at ? Date.parse(body.expires_at) : tok.expiresAt);
      this.tokens.set(secret, { id: body.id, secret, scope: body.scope, expiresAt, revoked: false });
      return json(201, { access_token: secret });
    }
    if (req.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const list = [...this.tokens.values()].filter((t) => !t.revoked && t.id.startsWith(prefix) && t.id !== "root");
      return json(200, { access_tokens: list.map((t) => ({ id: t.id, scope: t.scope, auto_prefix_streams: false })), has_more: false });
    }
    if (req.method === "DELETE") {
      const t = [...this.tokens.values()].find((x) => x.id === id && !x.revoked);
      if (!t) return err(404, "access_token_not_found");
      t.revoked = true;
      return json(200, {});
    }
    return err(405, "bad_method");
  }

  private async basin(req: Request, url: URL, tok: Token, can: (op: string) => boolean | undefined): Promise<Response> {
    const path = url.pathname;
    const m = path.match(/^\/basin\/([^/]+)\/v1\/streams(?:\/([^/]+))?(\/records)?(\/tail)?$/);
    if (!m) return err(404, "bad_path");
    const basin = m[1];
    if (!matches(tok.scope.basins, basin)) return err(403, "permission_denied");
    if (!m[2]) {
      if (!can("list-streams")) return err(403, "permission_denied");
      const prefix = url.searchParams.get("prefix") ?? "";
      const names = [...this.streams.keys()].filter((k) => k.startsWith(`${basin}/${prefix}`)).map((k) => k.slice(basin.length + 1));
      return json(200, { streams: names.filter((n) => matches(tok.scope.streams, n)).map((name) => ({ name, created_at: "" })), has_more: false });
    }
    const name = decodeURIComponent(m[2]);
    if (!matches(tok.scope.streams, name)) return err(403, "permission_denied");
    const stream = this.streams.get(`${basin}/${name}`);
    if (!m[3] && (req.method === "PUT" || req.method === "DELETE")) return this.ensureOrDelete(req, can, basin, name, stream);
    if (!stream) return err(404, "stream_not_found");
    const key32 = req.headers.get("s2-encryption-key");
    // Real s2 answers 400 bad_header (its docs say 422 invalid), for fence records too.
    if (m[3] && !m[4] && stream?.cipher && !key32) return err(400, "bad_header", "missing encryption key for stream cipher");
    const tail = () => ({ seq_num: stream.records.length, timestamp: stream.records.at(-1)?.timestamp ?? 0 });
    if (m[4]) return can("check-tail") ? json(200, { tail: tail() }) : err(403, "permission_denied");

    if (req.method === "POST") return this.append(req, can, stream, name, key32, tail);
    return this.read(req, url, can, stream, key32, tail);
  }

  private async ensureOrDelete(req: Request, can: (op: string) => boolean | undefined, basin: string, name: string, stream: Stream | undefined) {
    const key = `${basin}/${name}`;
    if (req.method === "PUT") {
      if (!can("create-stream")) return err(403, "permission_denied");
      const config = await req.json();
      if (stream) stream.config = config;
      else this.streams.set(key, { records: [], fence: "", config, waiters: new Set(), cipher: this.ciphers.has(basin), keys: [] });
      return json(stream ? 200 : 201, { name });
    }
    if (!can("delete-stream")) return err(403, "permission_denied");
    if (!stream) return err(404, "stream_not_found");
    this.streams.delete(key);
    return json(202, {});
  }

  private async append(req: Request, can: (op: string) => boolean | undefined, stream: Stream, name: string, key32: string | null, tail: () => { seq_num: number; timestamp: number }) {
    if (!can("append")) return err(403, "permission_denied");
    const body = (await req.json()) as { records: { headers?: [string, string][]; body?: string }[]; match_seq_num?: number; fencing_token?: string };
    if (!body.records.length || body.records.length > 1000) return err(422, "invalid");
    if (body.records.some(isFenceRecord) && !can("fence")) return err(403, "permission_denied");
    if (body.fencing_token !== undefined && body.fencing_token !== stream.fence) return json(412, { fencing_token_mismatch: stream.fence });
    if (body.match_seq_num !== undefined && body.match_seq_num !== stream.records.length) return json(412, { seq_num_mismatch: stream.records.length });
    const start = tail();
    for (const r of body.records) {
      stream.keys.push(key32 ?? "");
      stream.records.push({ seq_num: stream.records.length, timestamp: this.now(), headers: r.headers ?? [], body: r.body ?? "" });
      if (isFenceRecord(r)) stream.fence = r.body ?? "";
    }
    this.appends++;
    for (const w of stream.waiters) w();
    if (this.loseNextAck.delete(name)) throw new TypeError("fetch failed (fake: acknowledgement lost)");
    return json(200, { start, end: tail(), tail: tail() });
  }

  private async read(req: Request, url: URL, can: (op: string) => boolean | undefined, stream: Stream, key32: string | null, tail: () => { seq_num: number; timestamp: number }) {
    // GET records
    if (!can("read")) return err(403, "permission_denied");
    const q = url.searchParams;
    let from = q.has("seq_num")
      ? Number(q.get("seq_num"))
      : q.has("timestamp")
        ? (stream.records.find((r) => r.timestamp >= Number(q.get("timestamp")))?.seq_num ?? stream.records.length)
        : Math.max(0, stream.records.length - Number(q.get("tail_offset") ?? 0));
    const count = Math.min(1000, Number(q.get("count") ?? 1000));
    const wait = Number(q.get("wait") ?? 0);
    if (from > stream.records.length) {
      if (q.get("clamp") !== "true") return json(416, { tail: tail() });
      from = stream.records.length;
    }
    if (stream.cipher && stream.keys.slice(from).some((k, i) => k !== key32 && !isCmd(stream.records[from + i]))) return err(400, "decryption_failed");
    if (req.headers.get("accept") === "text/event-stream") return this.sse(stream, from, req.signal);
    if (from >= stream.records.length && wait > 0) {
      await new Promise<void>((resolve) => {
        const done = () => (stream.waiters.delete(done), clearTimeout(t), resolve());
        const t = setTimeout(done, Math.min(wait, 1) * 1000);
        stream.waiters.add(done);
        req.signal?.addEventListener("abort", done);
      });
    }
    const records = stream.records.slice(from, from + count);
    if (!records.length && wait === 0) return json(416, { tail: tail() });
    return json(200, { records, tail: tail() });
  }

  private sse(stream: Stream, from: number, signal: AbortSignal | null) {
    let pos = from;
    const enc = new TextEncoder();
    let wake: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      pull: async (ctl) => {
        while (pos >= stream.records.length) {
          if (signal?.aborted) return ctl.close();
          await new Promise<void>((r) => {
            wake = () => (stream.waiters.delete(wake!), r());
            stream.waiters.add(wake);
            signal?.addEventListener("abort", wake, { once: true });
          });
        }
        const records = stream.records.slice(pos, pos + 3); // small batches, so a drop can land mid-stream
        pos += records.length;
        ctl.enqueue(enc.encode(`event: batch\nid: ${pos},0,0\ndata: ${JSON.stringify({ records, tail: { seq_num: stream.records.length, timestamp: 0 } })}\n\n`));
      },
      cancel: () => {
        if (wake) wake();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
}
