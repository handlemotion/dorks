import { exportEventsPart, exportFile, exportManifest, importCreate, newImportKey, openImportSealed, type ExportEvent, type ExportFile, type ExportManifest, type Jwk } from "@dorks/shared";

// A reference implementation of the cloud's side of "Move to cloud" (docs/move-to-cloud.md), in memory: Better Auth's email-code
// sign-in, `GET /v1/orgs` and the import API, validating everything with @dorks/shared's schemas. The server tests use it as a fake
// fetch; the live check serves it over HTTP to a real dev server. dorks-cloud's Worker implements the same contract on D1 and s2.

type Import = { id: string; orgId: string; privateJwk: Jwk; manifest?: ExportManifest; events: Map<string, ExportEvent[]>; committed: boolean };

export class CloudImportStandIn {
  readonly imports = new Map<string, Import>();
  /** Opened secrets of the committed import: variables by name, MCP servers' sealed JSON by name. */
  opened: { variables: Record<string, string>; mcp: Record<string, unknown> } | null = null;
  /** Stops the next events upload after storing half of it (a dropped connection), to exercise the resume. */
  dropNextPart = false;
  maxPartBytes = 64 * 1024;
  runtime: "mac" | "cloud" = "mac";
  readonly token = "standin-session";

  constructor(readonly o: { orgId: string; macId: string; role?: string; plan?: string }) {}

  orgs() {
    return [
      { id: "personal-1", name: "Personal", personal: true, plan: "local", role: "owner", servers: [{ macId: this.o.macId, name: "Studio Mac", kind: "mac", online: true }] },
      {
        id: this.o.orgId,
        name: "Acme",
        personal: false,
        plan: this.o.plan ?? "teams",
        role: this.o.role ?? "owner",
        // The commit takes the org off this Mac: with no Mac left, the app runs it on the Worker.
        servers: this.runtime === "cloud" ? [] : [{ macId: this.o.macId, name: "Studio Mac", kind: "mac", online: true }],
      },
    ];
  }

  /** The committed import as one file, as `POST /api/cloud/export` would have produced it. */
  file(importId: string): ExportFile {
    const imp = this.imports.get(importId)!;
    return exportFile.parse({ ...imp.manifest!, events: Object.fromEntries([...imp.events]) });
  }

  handle = async (req: Request): Promise<Response> => {
    const p = new URL(req.url).pathname;
    if (p === "/api/auth/email-otp/send-verification-otp") return Response.json({ success: true });
    if (p === "/api/auth/sign-in/email-otp") return Response.json({ token: this.token, user: { id: "u1", name: "Ada", email: "ada@example.com" } });
    if (req.headers.get("authorization") !== `Bearer ${this.token}`) return Response.json({ message: "unauthorized" }, { status: 401 });
    if (p === "/v1/orgs" && req.method === "GET") return Response.json(this.orgs());
    return this.imports_(req, p);
  };

  /** The import API: `/v1/orgs/:orgId/imports[/:id[/manifest|/commit|/sessions/:sid/events]]`. */
  private async imports_(req: Request, p: string): Promise<Response> {
    const m = /^\/v1\/orgs\/([^/]+)\/imports(?:\/([^/]+)(\/manifest|\/commit|\/sessions\/([^/]+)\/events)?)?$/.exec(p);
    if (!m) return Response.json({ message: "not found" }, { status: 404 });
    const orgId = decodeURIComponent(m[1]);
    if (orgId !== this.o.orgId) return Response.json({ code: "not_found", message: "No such organization" }, { status: 404 });
    if (this.o.role && !["owner", "admin"].includes(this.o.role)) return Response.json({ code: "forbidden", message: "Only owners and admins can move an organization" }, { status: 403 });
    const body = req.method === "GET" ? null : await req.json().catch(() => null);
    if (!m[2] && req.method === "POST") return this.create(orgId, body);
    const imp = this.imports.get(decodeURIComponent(m[2] ?? ""));
    if (!imp) return Response.json({ code: "not_found", message: "No such import" }, { status: 404 });
    if (imp.committed && req.method !== "GET") return Response.json({ code: "conflict", message: "Already committed" }, { status: 409 });
    if (m[3] === "/manifest" && req.method === "PUT") return this.manifest(imp, body);
    if (m[4] && req.method === "PUT") return this.events(imp, decodeURIComponent(m[4]), body);
    if (m[3] === "/commit" && req.method === "POST") return this.commit(imp);
    if (!m[3] && req.method === "GET") return Response.json(this.status(imp));
    return Response.json({ message: "not found" }, { status: 404 });
  }

  private async create(orgId: string, body: unknown) {
    const r = importCreate.safeParse(body);
    if (!r.success) return Response.json({ code: "invalid", message: r.error.message }, { status: 400 });
    if (this.runtime === "cloud") return Response.json({ code: "conflict", message: "This organization already runs in the cloud" }, { status: 409 });
    const id = `imp_${this.imports.size + 1}`;
    const { key, privateJwk } = await newImportKey(`key-${id}`);
    this.imports.set(id, { id, orgId, privateJwk, events: new Map(), committed: false });
    return Response.json({ importId: id, key, maxPartBytes: this.maxPartBytes, expiresAt: Date.now() + 86_400_000 }, { status: 201 });
  }

  private manifest(imp: Import, body: unknown) {
    const r = exportManifest.safeParse(body);
    if (!r.success) return Response.json({ code: "invalid", message: r.error.message }, { status: 400 });
    if (r.data.orgId !== imp.orgId || r.data.importId !== imp.id) return Response.json({ code: "invalid", message: "Manifest for another import" }, { status: 400 });
    imp.manifest = r.data;
    return Response.json({ ok: true });
  }

  private status(imp: Import) {
    return { status: imp.committed ? "committed" : "open", sessions: Object.fromEntries([...imp.events].map(([id, evs]) => [id, { nextSeq: (evs.at(-1)?.seq ?? 0) + 1 }])) };
  }

  /** Consecutive seqs only: a part that overlaps what is stored is trimmed; one that leaves a gap is refused with where to resume. */
  private events(imp: Import, sessionId: string, body: unknown) {
    const s = imp.manifest?.sessions.find((x) => x.id === sessionId);
    if (!s) return Response.json({ code: "not_found", message: "Upload the manifest first, then this session's events" }, { status: 404 });
    const r = exportEventsPart.safeParse(body);
    if (!r.success) return Response.json({ code: "invalid", message: r.error.message }, { status: 400 });
    const have = imp.events.get(sessionId) ?? [];
    const next = (have.at(-1)?.seq ?? 0) + 1;
    const fresh = r.data.events.filter((e) => e.seq >= next);
    if (fresh.length && fresh[0].seq !== next) return Response.json({ code: "conflict", message: "Gap", expectedSeq: next }, { status: 409 });
    if (fresh.some((e, i) => e.seq !== next + i)) return Response.json({ code: "invalid", message: "Events must be consecutive" }, { status: 400 });
    const keep = this.dropNextPart ? fresh.slice(0, Math.ceil(fresh.length / 2)) : fresh;
    imp.events.set(sessionId, [...have, ...keep]);
    if (this.dropNextPart) {
      this.dropNextPart = false;
      return Response.json({ code: "conflict", message: "Stored part of it", expectedSeq: next + keep.length }, { status: 409 });
    }
    return Response.json({ expectedSeq: next + keep.length });
  }

  private async commit(imp: Import) {
    if (!imp.manifest) return Response.json({ code: "invalid", message: "No manifest" }, { status: 400 });
    const missing = imp.manifest.sessions.flatMap((s) => {
      const n = imp.events.get(s.id)?.length ?? 0;
      return n === s.events.count ? [] : [{ sessionId: s.id, nextSeq: n + 1 }];
    });
    if (missing.length) return Response.json({ code: "conflict", message: "Some events are missing", missing }, { status: 409 });
    const open = await openImportSealed(imp.privateJwk, imp.manifest);
    const variables: Record<string, string> = {};
    for (const v of imp.manifest.variables) variables[v.name] = await open(`variable|${v.name}`, v.value);
    const mcp: Record<string, unknown> = {};
    for (const s of imp.manifest.mcpServers) mcp[s.name] = JSON.parse(await open(`mcp|${s.name}`, s.secrets));
    this.opened = { variables, mcp };
    imp.committed = true;
    this.runtime = "cloud";
    const events = imp.manifest.sessions.reduce((n, s) => n + s.events.count, 0);
    return Response.json({ runtime: "cloud", sessions: imp.manifest.sessions.length, events });
  }
}
