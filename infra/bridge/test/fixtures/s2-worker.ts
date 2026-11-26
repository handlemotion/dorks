import { checkHttpProof, type ToBridge } from "@dorks/shared";
import { createServer, type Server } from "node:http";
import { Assembler, type SessionItem } from "../../src/s2/records";
import { S2 } from "../../src/s2/s2";

// A stand-in for the cloud Worker's bridge endpoints (connect, token, state, rpc; handlemotion/dorks-cloud builds the real ones),
// doing on s2 exactly what its src/realtime does: ensure the session's streams, fence events with a fresh UUID on every connect,
// issue a bridge token scoped to the session's prefix (append, read, check-tail; never fence), derive the session's stream key
// from a KEK, and append commands as sendCommand does. Runs as a fetch handler (fake s2) or over HTTP (real s2, a real bridge).

export class StandInWorker {
  readonly streams: { prefix: string; events: string; commands: string };
  /** Every state frame the bridge sent, in order. */
  readonly state: { t: string; [k: string]: unknown }[] = [];
  readonly rpcs: { op: string; args: unknown }[] = [];
  connects = 0;
  tokens = 0;
  heartbeats = 0;
  configure: Extract<ToBridge, { t: "configure" }> | null = null;
  /** Fences handed out, oldest first. */
  readonly fences: string[] = [];
  private server?: Server;

  constructor(
    readonly o: {
      admin: S2;
      org: string;
      session: string;
      secret: string;
      kek?: string;
      tokenTtlMs?: number;
      /** Like the server (enqueueConfigure): every connect appends a fetch_configure for the bridge. */
      configureOnConnect?: boolean;
    },
  ) {
    const prefix = `orgs/${o.org}/sessions/${o.session}/`;
    this.streams = { prefix, events: `${prefix}events`, commands: `${prefix}commands` };
  }

  async key(): Promise<string | null> {
    if (!this.o.kek) return null;
    const ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.o.kek), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("dorks-realtime-v1"), info: new TextEncoder().encode(this.streams.prefix) }, ikm, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }

  private async s2() {
    return this.o.admin.withKey((await this.key()) ?? undefined);
  }

  async open() {
    const common = { storage_class: "express", delete_on_empty: { min_age_secs: 86_400 }, timestamping: { mode: "arrival" } } as const;
    await this.o.admin.ensureStream(this.streams.events, { ...common, retention_policy: { age: 86_400 } });
    await this.o.admin.ensureStream(this.streams.commands, { ...common, retention_policy: { age: 86_400 } });
  }

  private async issue() {
    this.tokens++;
    const expiresAt = Date.now() + (this.o.tokenTtlMs ?? 3_600_000);
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
    const token = await this.o.admin.issueToken(
      `rt/${this.o.org}/${this.o.session}/b.${Date.now().toString(36)}.${rand}`,
      { basins: { exact: this.o.admin.basin }, streams: { prefix: this.streams.prefix }, ops: ["append", "read", "check-tail"] },
      new Date(expiresAt),
    );
    return { token, expiresAt };
  }

  /** The Worker's sendCommand: the cid is the record's id (and the message frame's id). */
  async sendCommand(cid: string, frame: object) {
    const ack = await (
      await this.s2()
    ).append(this.streams.commands, [
      {
        headers: [
          ["id", cid],
          ["by", "e2e"],
        ],
        body: JSON.stringify(frame),
      },
    ]);
    return ack.start.seq_num;
  }

  /** The transcript as a member's client reads it. */
  async transcript(): Promise<SessionItem[]> {
    const s2 = await this.s2();
    const asm = new Assembler();
    const out: SessionItem[] = [];
    for (let seq = 0; ;) {
      const { records } = await s2.read(this.streams.events, { seqNum: seq }, { count: 1000 });
      if (!records.length) return out;
      for (const r of records) out.push(...asm.push(r));
      seq = records.at(-1)!.seq_num + 1;
    }
  }

  async rawEvents() {
    const { records } = await (await this.s2()).read(this.streams.events, { seqNum: 0 }, { count: 1000 });
    return records;
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const m = /^\/v1\/bridge\/([^/]+)\/(connect|token|state|rpc)$/.exec(url.pathname);
    if (!m || req.method !== "POST") return Response.json({ code: "not_found", message: "no route" }, { status: 404 });
    const body = await req.text();
    if (decodeURIComponent(m[1]) !== this.o.session || !(await checkHttpProof(this.o.secret, req.headers.get("authorization"), { method: "POST", path: url.pathname, body })))
      return Response.json({ code: "forbidden", message: "forbidden" }, { status: 403 });
    const args = JSON.parse(body || "{}");
    if (m[2] === "connect") {
      this.connects++;
      await this.open();
      const fence = crypto.randomUUID();
      this.fences.push(fence);
      await (await this.s2()).fence(this.streams.events, fence);
      const { token, expiresAt } = await this.issue();
      if (this.o.configureOnConnect) await this.sendCommand(`cfg-${this.connects}-${Date.now().toString(36)}`, { t: "fetch_configure" });
      return Response.json({ basin: this.o.admin.basin, basinUrl: this.o.admin.basinUrl, streams: this.streams, token, tokenExpiresAt: expiresAt, fence, encryptionKey: await this.key() });
    }
    if (m[2] === "token") return Response.json(await this.issue());
    if (m[2] === "state") {
      if (!args.frames.length) this.heartbeats++;
      this.state.push(...args.frames);
      return Response.json({ ok: true });
    }
    this.rpcs.push({ op: args.op, args: args.args });
    if (args.op === "configure") return Response.json({ result: this.configure });
    return Response.json({ result: null });
  };

  /** Serves `handle` over HTTP on loopback; resolves with the base URL. */
  async listen(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await this.handle(
        new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }),
      );
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  /** Revokes the session's tokens and deletes its streams. */
  async cleanup() {
    this.server?.close();
    for (const t of await this.o.admin.listTokens(`rt/${this.o.org}/${this.o.session}/`)) await this.o.admin.revokeToken(t.id);
    await this.o.admin.deleteStream(this.streams.events);
    await this.o.admin.deleteStream(this.streams.commands);
  }
}
