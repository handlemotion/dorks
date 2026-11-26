import { hostname } from "node:os";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "../core/crypto";
import { update } from "../db";
import { FAILURE_MESSAGE, memberFromToken, routedPath, runAs, serverOrg, teamAllowed, type Actor } from "./team";

// The phone link (docs/mobile.md): the iPhone app reaches this server through the cloud relay. The server dials out to the relay
// (like the bridge links, it opens no port), and runs each relayed request against its own UI API with the owner token, but only
// when the relay allowlist below lets it through: the relay forwards, this server decides.

const PAIR_POLL_MS = 2_000;
const PING_MS = 25_000;
const SILENT_MS = 70_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_IN_FLIGHT = 64;
/**
 * What the cloud says of this server (docs/mobile.md, `PATCH /v1/mac`): the organization that owns it, and who paired it (the local
 * owner's name and id for attribution, services/team.ts). A field the cloud does not send is kept as it was.
 */
function saveMac(app: App, r: { orgId?: unknown; pairedBy?: unknown }) {
  const patch: Record<string, unknown> = {};
  if (typeof r.orgId === "string" && r.orgId) patch.cloudOrgId = r.orgId;
  const p = r.pairedBy as { id?: unknown; name?: unknown; email?: unknown } | undefined;
  if (p && typeof p.id === "string" && p.id)
    patch.cloudOwner = { id: p.id, name: typeof p.name === "string" ? p.name.slice(0, 80) : "", ...(typeof p.email === "string" ? { email: p.email.slice(0, 200) } : {}) };
  const was = app.db.get<{ cloud_org_id: string | null; cloud_owner: string | null }>("SELECT cloud_org_id, cloud_owner FROM settings WHERE id = 1");
  const same = (patch.cloudOrgId ?? was?.cloud_org_id) === was?.cloud_org_id && (patch.cloudOwner ? JSON.stringify(patch.cloudOwner) : was?.cloud_owner) === was?.cloud_owner;
  if (same) return;
  app.db.tx(() => {
    update(app.db, "settings", { id: 1 }, patch);
    touch(app, { t: "settings" });
  });
}

/** The relay closes a socket whose Mac token was revoked with this code: the pairing is over. */
const REVOKED = 4401;

export type LinkState = "off" | "connecting" | "online" | "offline";

export interface Pairing {
  code: string;
  url: string;
  expiresAt: number;
}

export interface PhoneView {
  cloudUrl: string | null;
  paired: boolean;
  macId: string | null;
  name: string | null;
  link: LinkState;
  pairing: Pairing | null;
}

// ---- the allowlist (docs/mobile.md, "Relay allowlist")

const ALLOWED: [method: string, path: RegExp][] = [
  ["GET", /^\/api\/(live|settings|usage|github\/repos|builds|skills|mcp-servers|composio)$/],
  ["GET", /^\/api\/builds\/[^/]+$/],
  ["POST", /^\/api\/images$/],
  ["GET", /^\/api\/images\/[^/]+$/],
  ["POST", /^\/api\/skills(\/resolve)?$/],
  ["POST", /^\/api\/skills\/[^/]+\/update$/],
  ["DELETE", /^\/api\/skills\/[^/]+$/],
  ["*", /^\/api\/dorks(\/.*)?$/],
  // Automations: list them and their runs, switch one on or off, run one now.
  ["GET", /^\/api\/automations(\/[^/]+(\/runs)?)?$/],
  ["PATCH", /^\/api\/automations\/[^/]+$/],
  ["POST", /^\/api\/automations\/[^/]+\/runs$/],
];
/** Under /api/dorks: running commands on this computer, secret values, and the live view of a box stay on the Mac. */
const DENIED = /^\/api\/dorks\/[^/]+\/(local|inputs|desktop)(\/|$)/;

/** Whether a relayed request may run. `path` is the pathname alone; encoded slashes and dots are refused outright. */
export function relayAllowed(method: string, raw: string): boolean {
  const path = routedPath(raw);
  if (path === null || DENIED.test(path)) return false;
  return ALLOWED.some(([m, re]) => (m === "*" || m === method) && re.test(path));
}

// ---- frames (docs/mobile.md, "Link protocol")

type ReqFrame = { t: "req"; id: number | string; method: string; path: string; headers?: Record<string, string>; body?: string };
type InFrame = ReqFrame | { t: "cancel"; id: number | string } | { t: "ping" } | { t: "pong" };

type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: ((e: { code?: number }) => void) | null;
  onerror: ((e: unknown) => void) | null;
};
export type Dial = (url: string, headers: Record<string, string>) => Socket;
const defaultDial: Dial = (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as Socket;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const refusal = (message: string) => JSON.stringify({ error: { code: "forbidden", message } });

/**
 * Who a relayed request is (services/team.ts): the member its `x-dorks-actor` token names, checked against the cloud's keys and this
 * server's organization; with no token, the single owner's phone of docs/mobile.md, only while this server has no organization.
 */
async function relayActor(app: App, f: ReqFrame): Promise<{ actor: Actor } | { refuse: string }> {
  const token = f.headers?.["x-dorks-actor"];
  if (typeof token === "string" && token) {
    const r = await memberFromToken(app, token);
    return r.ok ? { actor: r.actor } : { refuse: FAILURE_MESSAGE[r.why] };
  }
  if (serverOrg(app)) return { refuse: "Sign in again: this server needs to know who you are." };
  return { actor: { kind: "phone" } };
}

const allowedFor = (actor: Actor, method: string, path: string) => (actor.kind === "member" ? teamAllowed(actor.member.role, method, path) : relayAllowed(method, path));

/**
 * Runs one relayed request against the UI API and streams the answer as frames. Exported for tests: `handle` is the UI app's fetch.
 */
/** The request a relayed frame becomes against the UI API: the owner token, the frame's content type and accept, its body. */
function innerRequest(app: App, f: ReqFrame, url: URL, method: string, signal: AbortSignal): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${app.cfg.ownerToken}` };
  for (const k of ["content-type", "accept"]) {
    const v = f.headers?.[k];
    if (typeof v === "string") headers[k] = v;
  }
  const body = f.body && method !== "GET" && method !== "HEAD" ? Buffer.from(f.body, "base64") : undefined;
  // Images are served outside /api (an <img> cannot send the owner token); the relay only forwards /api, so map them back.
  const path = method === "GET" && /^\/api\/images\/[^/]+$/.test(url.pathname) ? url.pathname.slice(4) : url.pathname;
  return new Request(`http://127.0.0.1${path}${url.search}`, { method, headers, body, signal });
}

/** The actor a relayed frame may run as, or why it may not. */
async function admit(app: App, f: ReqFrame, method: string, pathname: string): Promise<{ actor: Actor } | { refuse: string }> {
  const who = await relayActor(app, f);
  if ("refuse" in who) return who;
  return pathname.startsWith("/api/") && allowedFor(who.actor, method, pathname) ? who : { refuse: "Not available from here" };
}

export async function serveRelayed(app: App, handle: (r: Request) => Response | Promise<Response>, f: ReqFrame, send: (o: object) => void, signal: AbortSignal) {
  const url = new URL(f.path, "http://relay.local");
  const method = f.method.toUpperCase();
  const who = await admit(app, f, method, url.pathname);
  if ("refuse" in who) {
    send({ t: "head", id: f.id, status: 403, headers: { "content-type": "application/json" } });
    send({ t: "chunk", id: f.id, data: b64(new TextEncoder().encode(refusal(who.refuse))) });
    return send({ t: "end", id: f.id });
  }
  const res = await handle(runAs(who.actor, innerRequest(app, f, url, method, signal)));
  const ct = res.headers.get("content-type");
  send({ t: "head", id: f.id, status: res.status, headers: ct ? { "content-type": ct } : {} });
  if (res.body) {
    const reader = res.body.getReader();
    const stop = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        if (value?.length) send({ t: "chunk", id: f.id, data: b64(value) });
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  if (!signal.aborted) send({ t: "end", id: f.id });
}

// ---- the link

interface Paired {
  macId: string;
  name: string;
  token: string;
}

export interface PhoneLink {
  view(): PhoneView;
  pair(name?: string): Promise<Pairing>;
  cancelPair(): void;
  unpair(): Promise<void>;
  stop(): void;
}

const links = new WeakMap<App, PhoneLink>();

/** The running link, for the routes. Null before `startPhoneLink` (tests that do not start one). */
export const phoneLink = (app: App): PhoneLink => links.get(app) ?? fail("not_configured", "The phone link is not running");

async function readPaired(app: App): Promise<Paired | null> {
  const r = app.db.get<{ cloud_mac_id: string | null; cloud_mac_name: string | null; cloud_mac_token_enc: string | null }>(
    "SELECT cloud_mac_id, cloud_mac_name, cloud_mac_token_enc FROM settings WHERE id = 1",
  );
  if (!r?.cloud_mac_id || !r.cloud_mac_token_enc) return null;
  try {
    return { macId: r.cloud_mac_id, name: r.cloud_mac_name ?? "", token: await decrypt(app.ring, r.cloud_mac_token_enc, aad.cloudMacToken(OWNER)) };
  } catch {
    return null;
  }
}

function savePaired(app: App, p: { macId: string; name: string; tokenEnc: string; orgId?: string | null } | null) {
  app.db.tx(() => {
    update(app.db, "settings", { id: 1 }, { cloudMacId: p?.macId ?? null, cloudMacName: p?.name ?? null, cloudMacTokenEnc: p?.tokenEnc ?? null, cloudOrgId: p?.orgId ?? null, cloudOwner: null });
    touch(app, { t: "settings" });
  });
}

const macName = () => hostname().replace(/\.local$/, "") || "Mac";

export function startPhoneLink(app: App, handle: (r: Request) => Response | Promise<Response>, dial: Dial = defaultDial, pollMs = PAIR_POLL_MS): PhoneLink {
  const cloud = app.cfg.cloudUrl?.replace(/\/+$/, "") || null;
  let stopped = false;
  let paired: Paired | null = null;
  let state: LinkState = "off";
  let ws: Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let pinger: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  let lastSeen = 0;
  const inFlight = new Map<string, AbortController>();
  let pairing: (Pairing & { pairId: string; pollToken: string; timer?: ReturnType<typeof setTimeout> }) | null = null;

  const setState = (s: LinkState) => {
    if (s === state) return;
    state = s;
    app.hub.emit({ t: "settings" });
  };

  const send = (o: object) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(o));
  };

  const drop = () => {
    clearInterval(pinger);
    for (const c of inFlight.values()) c.abort();
    inFlight.clear();
    const old = ws;
    ws = undefined;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close(1000, "done");
      } catch {
        /* already closed */
      }
    }
  };

  const schedule = () => {
    if (stopped || !paired) return setState("off");
    setState("offline");
    clearTimeout(retry);
    retry = setTimeout(connect, Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** failures++));
  };

  const onFrame = (f: InFrame) => {
    lastSeen = app.now();
    if (f.t === "ping") return send({ t: "pong" });
    if (f.t === "cancel") return inFlight.get(String(f.id))?.abort();
    if (f.t !== "req") return;
    const key = String(f.id);
    if (inFlight.size >= MAX_IN_FLIGHT) {
      send({ t: "head", id: f.id, status: 429, headers: { "content-type": "application/json" } });
      send({ t: "chunk", id: f.id, data: b64(new TextEncoder().encode(JSON.stringify({ error: { code: "limit", message: "Too many requests" } }))) });
      return send({ t: "end", id: f.id });
    }
    const ctl = new AbortController();
    inFlight.set(key, ctl);
    void serveRelayed(app, handle, f, send, ctl.signal)
      .catch(() => {
        if (!ctl.signal.aborted) send({ t: "error", id: f.id, message: "failed" });
      })
      .finally(() => inFlight.delete(key));
  };

  /** Each time the link opens: which organization owns this server now (a Mac paired before teams learns it here). */
  async function learnOrg() {
    const p = paired;
    if (!p || !cloud) return;
    try {
      const res = await app.fetch(`${cloud}/v1/mac`, { method: "PATCH", headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" }, body: "{}" });
      if (res.ok && paired === p) saveMac(app, (await res.json()) as { orgId?: unknown; pairedBy?: unknown });
    } catch {
      /* an older relay, or unreachable for now: the next open asks again */
    }
  }

  function connect() {
    if (stopped || !paired || !cloud) return;
    drop();
    setState("connecting");
    let sock: Socket;
    try {
      sock = dial(`${cloud.replace(/^http/, "ws")}/v1/mac/connect`, { authorization: `Bearer ${paired.token}` });
    } catch {
      return schedule();
    }
    ws = sock;
    sock.onopen = () => {
      failures = 0;
      void learnOrg();
      lastSeen = app.now();
      setState("online");
      pinger = setInterval(() => {
        if (app.now() - lastSeen > SILENT_MS) return connect(); // half-open: dial again
        send({ t: "ping" });
      }, PING_MS);
    };
    sock.onmessage = (m) => {
      try {
        onFrame(JSON.parse(String(m.data)) as InFrame);
      } catch {
        /* a malformed frame is ignored */
      }
    };
    sock.onerror = () => {};
    sock.onclose = (e) => {
      if (ws !== sock) return;
      drop();
      if (e?.code === REVOKED) {
        console.error("phone link: this Mac was unpaired in the cloud");
        paired = null;
        savePaired(app, null);
        return setState("off");
      }
      schedule();
    };
  }

  const cancelPair = () => {
    if (pairing?.timer) clearTimeout(pairing.timer);
    if (pairing) app.hub.emit({ t: "settings" });
    pairing = null;
  };

  async function pollPairing(p: NonNullable<typeof pairing>) {
    if (pairing !== p || stopped) return;
    if (app.now() > p.expiresAt) return cancelPair();
    try {
      const res = await app.fetch(`${cloud}/v1/pair/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairId: p.pairId, pollToken: p.pollToken }) });
      if (pairing !== p) return;
      if (res.status === 404) return cancelPair();
      const r = (await res.json()) as { status: string; macId?: string; macToken?: string; orgId?: string };
      if (r.status === "claimed" && r.macId && r.macToken) {
        const name = macName();
        const tokenEnc = (await encrypt(app.ring, r.macToken, aad.cloudMacToken(OWNER))).value;
        // Reading the body and encrypting both yield: a Cancel or a newer pairing meanwhile wins over this answer.
        if (pairing !== p || stopped) return;
        savePaired(app, { macId: r.macId, name, tokenEnc, orgId: typeof r.orgId === "string" ? r.orgId : null });
        paired = { macId: r.macId, name, token: r.macToken };
        pairing = null;
        failures = 0;
        connect();
        return;
      }
    } catch {
      /* the relay is unreachable for now: keep polling until the code expires */
    }
    if (pairing === p) p.timer = setTimeout(() => void pollPairing(p), pollMs);
  }

  const link: PhoneLink = {
    view: () => ({
      cloudUrl: cloud,
      paired: !!paired,
      macId: paired?.macId ?? null,
      name: paired?.name ?? null,
      link: paired ? state : "off",
      pairing: pairing ? { code: pairing.code, url: pairing.url, expiresAt: pairing.expiresAt } : null,
    }),
    async pair(name) {
      if (!cloud) fail("not_configured", "The phone relay is turned off (DORKS_CLOUD_URL is empty)");
      cancelPair();
      let res: Response;
      try {
        res = await app.fetch(`${cloud}/v1/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name?.trim() || macName() }) });
      } catch {
        fail("failed", "Cannot reach the Dorks cloud. Check your connection and try again.");
      }
      if (!res.ok) fail("failed", `The Dorks cloud refused to start pairing (${res.status})`);
      const r = (await res.json()) as { pairId: string; pollToken: string; code: string; expiresAt: number };
      const code = r.code.replace(/-/g, "").toUpperCase();
      pairing = { pairId: r.pairId, pollToken: r.pollToken, code: `${code.slice(0, 4)}-${code.slice(4)}`, url: `dorks://pair?code=${code}&cloud=${encodeURIComponent(cloud)}`, expiresAt: r.expiresAt };
      const p = pairing;
      p.timer = setTimeout(() => void pollPairing(p), pollMs);
      app.hub.emit({ t: "settings" });
      return { code: p.code, url: p.url, expiresAt: p.expiresAt };
    },
    cancelPair,
    async unpair() {
      const was = paired;
      paired = null;
      clearTimeout(retry);
      drop();
      savePaired(app, null);
      setState("off");
      if (was && cloud) {
        // Best effort: a Mac that cannot reach the cloud still forgets its token; the phone shows it offline until removed there.
        await app.fetch(`${cloud}/v1/mac`, { method: "DELETE", headers: { authorization: `Bearer ${was.token}` } }).catch(() => {});
      }
    },
    stop() {
      stopped = true;
      cancelPair();
      clearTimeout(retry);
      drop();
      links.delete(app);
    },
  };
  links.set(app, link);
  if (cloud)
    void readPaired(app).then((p) => {
      if (stopped || !p) return;
      paired = p;
      connect();
    });
  return link;
}
