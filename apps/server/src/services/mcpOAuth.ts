import { createHash, randomBytes } from "node:crypto";
import { AppFail, fail, type App } from "../app";
import { open, saveOAuth, serverRow, type McpServerSealed } from "./mcpServers";

// MCP authorization (docs/mcp.md, "OAuth"): a remote server that answers 401 the OAuth way is signed in to by the owner in a browser,
// never in a sandbox. The server finds the authorization server (RFC 9728 protected resource metadata, then RFC 8414 / OpenID
// discovery), registers itself as a public client (RFC 7591), runs the code flow with PKCE and a resource indicator (RFC 8707), and
// keeps the tokens sealed with the server's other values. Agents never see the refresh token: the bridge proxies the server and asks
// for a current access token over its authenticated socket (`mcp_token`), which refreshes it here when it is about to expire.

/** What the sealed envelope keeps for an OAuth server. */
export interface OAuthSealed {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  scope?: string;
  client: { id: string; secret?: string; auth: "none" | "client_secret_basic" | "client_secret_post"; redirectUri: string };
  tokens?: { access: string; refresh?: string; expiresAt: number | null };
}

const TIMEOUT_MS = 10_000;
const PENDING_MS = 10 * 60_000;
/** A token this close to expiry is refreshed before it is handed out. */
const MARGIN_MS = 60_000;
export const CALLBACK_PATH = "/oauth/mcp/callback";

interface Pending {
  name: string;
  verifier: string;
  expiresAt: number;
}
/** Sign-ins waiting for their callback, by `state`. In memory: a restart only means starting the sign-in again. */
const pending = new Map<string, Pending>();
/** One refresh at a time per server: refresh tokens may rotate, and a second use of the old one can revoke the grant. */
const refreshing = new Map<string, Promise<AccessToken>>();

const b64url = (b: Buffer) => b.toString("base64url");

async function get(app: App, url: string): Promise<Json | null> {
  try {
    const res = await app.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = (await res.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/** An unauthenticated MCP `initialize`, which an OAuth server answers with 401 and a `WWW-Authenticate` pointing at its metadata. */
async function probe(app: App, url: string, headers: Record<string, string>): Promise<Response | null> {
  try {
    return await app.fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dorks", version: "1" } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

const param = (header: string, name: string) => new RegExp(`${name}="([^"]*)"`, "i").exec(header)?.[1];

const httpsOrLoopback = (raw: unknown): raw is string => {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
};

/** `/.well-known/<kind>` inserted before the path, as RFC 8414 and RFC 9728 place it, then at the root. */
function wellKnown(base: string, kind: string): string[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, "");
  return [...(path ? [`${u.origin}/.well-known/${kind}${path}`] : []), `${u.origin}/.well-known/${kind}`];
}

interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource: string;
  scope?: string;
}

type Json = Record<string, unknown>;

/** The first of `urls` whose JSON passes `ok`. */
async function firstJson(app: App, urls: string[], ok: (j: Json) => boolean): Promise<Json | null> {
  for (const u of new Set(urls)) {
    const j = await get(app, u);
    if (j && ok(j)) return j;
  }
  return null;
}

/** The authorization server's metadata: RFC 8414 first, then OpenID discovery (inserted before the path, then appended to it). */
function findAuthServer(app: App, issuer: string): Promise<Json | null> {
  const path = new URL(issuer).pathname.replace(/\/+$/, "");
  const urls = [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration"), ...(path ? [`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`] : [])];
  return firstJson(app, urls, (j) => httpsOrLoopback(j.authorization_endpoint) && httpsOrLoopback(j.token_endpoint));
}

/** What to ask for: the challenge's scope, else what the resource lists, plus offline_access when the server offers it. */
function scopeOf(www: string, prm: Json | null, as: Json): string | undefined {
  const listed = Array.isArray(prm?.scopes_supported) ? (prm.scopes_supported as string[]).join(" ") : undefined;
  const scope = (param(www, "scope") ?? listed)?.trim();
  if (!scope) return undefined;
  // Without offline_access some servers issue no refresh token, and agents would lose the server within the hour.
  const offline = Array.isArray(as.scopes_supported) && as.scopes_supported.includes("offline_access") && !scope.split(" ").includes("offline_access");
  return offline ? `${scope} offline_access` : scope;
}

/** Where to sign in to the server at `url`, or null when it does not speak MCP authorization. */
async function discover(app: App, url: string, headers: Record<string, string>): Promise<Discovery | null> {
  const res = await probe(app, url, headers);
  if (res?.status !== 401) return null;
  const www = res.headers.get("www-authenticate") ?? "";
  const metadataUrl = param(www, "resource_metadata");
  const prmUrls = [...(httpsOrLoopback(metadataUrl) ? [metadataUrl] : []), ...wellKnown(url, "oauth-protected-resource")];
  const prm = await firstJson(app, prmUrls, (j) => Array.isArray(j.authorization_servers));
  // No protected resource metadata: the 2025-03-26 spec's server, which is its own authorization server.
  const issuer: string | undefined = prm ? (prm.authorization_servers as unknown[]).find(httpsOrLoopback) : new URL(url).origin;
  if (!issuer) return null;
  const as = await findAuthServer(app, issuer);
  if (!as) return null;
  return {
    issuer,
    authorizationEndpoint: as.authorization_endpoint as string,
    tokenEndpoint: as.token_endpoint as string,
    registrationEndpoint: httpsOrLoopback(as.registration_endpoint) ? as.registration_endpoint : undefined,
    resource: typeof prm?.resource === "string" ? prm.resource : url.split("#")[0]!,
    scope: scopeOf(www, prm, as),
  };
}

/** Whether saving `url` should offer a sign-in: it answers 401 and publishes authorization metadata. */
export async function asksForOAuth(app: App, url: string, headers: Record<string, string>): Promise<boolean> {
  return !!(await discover(app, url, headers));
}

/** Registers Dorks with the authorization server as a public client (or whatever kind it hands back). */
async function register(app: App, endpoint: string, redirectUri: string): Promise<OAuthSealed["client"]> {
  let res: Response;
  try {
    res = await app.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Dorks",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    fail("failed", "The server's sign-in could not be reached");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.client_id !== "string") fail("failed", `The server refused to register Dorks (${oauthError(body) ?? res.status})`);
  const method = body.token_endpoint_auth_method;
  const secret = typeof body.client_secret === "string" ? body.client_secret : undefined;
  const auth = method === "client_secret_post" || method === "client_secret_basic" ? method : secret ? "client_secret_basic" : "none";
  return { id: body.client_id, secret, auth, redirectUri };
}

const oauthError = (b: Record<string, unknown>) => (typeof b.error === "string" ? `${b.error}${typeof b.error_description === "string" ? `: ${b.error_description.slice(0, 200)}` : ""}` : undefined);

function sealedOf(sealed: McpServerSealed, name: string): OAuthSealed {
  return sealed.oauth ?? fail("invalid", `${name} has no sign-in; start it from Customize`);
}

/** A sign-in page for the server `name`: the owner opens it in a browser, which comes back to `<base>/oauth/mcp/callback`. */
export async function startMcpSignIn(app: App, name: string, base: unknown): Promise<{ url: string }> {
  const row = serverRow(app, name) ?? fail("not_found", "no such server");
  if (row.transport !== "http") fail("invalid", "only a remote server signs in");
  if (typeof base !== "string" || !/^https?:\/\//.test(base)) fail("invalid", "base must be the server's URL");
  const redirectUri = `${new URL(base).origin}${CALLBACK_PATH}`;
  const sealed = await open(app, row);
  const url = sealed.url ?? row.url ?? "";
  const d = await discover(app, url, sealed.headers);
  if (!d) fail("invalid", `${name} does not ask for a sign-in. If it needs a token, add it as a header.`);
  const prev = sealed.oauth;
  const reuse = prev && prev.issuer === d.issuer && prev.client.redirectUri === redirectUri;
  let client = reuse ? prev.client : undefined;
  if (!client) {
    if (!d.registrationEndpoint) fail("invalid", `${name}'s sign-in does not let new apps register. Add a token as a header instead.`);
    client = await register(app, d.registrationEndpoint, redirectUri);
  }
  const { registrationEndpoint: _, ...where } = d;
  sealed.oauth = { ...where, client, tokens: prev?.tokens };
  if (!(await saveOAuth(app, name, row.oauth ?? "signed_out", sealed, false, row.secrets_enc))) fail("failed", `${name} changed meanwhile; try again`);

  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const now = app.now();
  for (const [k, p] of pending) if (p.expiresAt < now) pending.delete(k);
  pending.set(state, { name, verifier, expiresAt: now + PENDING_MS });
  const q = new URL(d.authorizationEndpoint);
  q.searchParams.set("response_type", "code");
  q.searchParams.set("client_id", client.id);
  q.searchParams.set("redirect_uri", redirectUri);
  q.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  q.searchParams.set("code_challenge_method", "S256");
  q.searchParams.set("state", state);
  q.searchParams.set("resource", d.resource);
  if (d.scope) q.searchParams.set("scope", d.scope);
  return { url: q.href };
}

type TokenGrant = { grant_type: "authorization_code"; code: string; code_verifier: string } | { grant_type: "refresh_token"; refresh_token: string };

/** Calls the token endpoint. `invalid_grant` means the grant is gone (revoked, expired): the owner must sign in again. */
async function tokenRequest(app: App, o: OAuthSealed, grant: TokenGrant): Promise<NonNullable<OAuthSealed["tokens"]>> {
  const form = new URLSearchParams({ ...grant, resource: o.resource });
  if (grant.grant_type === "authorization_code") form.set("redirect_uri", o.client.redirectUri);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (o.client.auth === "client_secret_basic" && o.client.secret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(o.client.id)}:${encodeURIComponent(o.client.secret)}`).toString("base64")}`;
  } else {
    form.set("client_id", o.client.id);
    if (o.client.auth === "client_secret_post" && o.client.secret) form.set("client_secret", o.client.secret);
  }
  let res: Response;
  try {
    res = await app.fetch(o.tokenEndpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    fail("failed", "The server's sign-in could not be reached");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    if (body.error === "invalid_grant" || res.status === 401) throw new GrantGone(oauthError(body) ?? `answered ${res.status}`);
    fail("failed", `The server's sign-in answered ${oauthError(body) ?? res.status}`);
  }
  const expiresIn = Number(body.expires_in);
  return {
    access: body.access_token,
    refresh: typeof body.refresh_token === "string" ? body.refresh_token : grant.grant_type === "refresh_token" ? grant.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? app.now() + expiresIn * 1000 : null,
  };
}

class GrantGone extends Error {}

/** The callback the authorization server sends the browser to. Never throws: its answer is a page for the owner. */
export async function finishMcpSignIn(app: App, q: { state?: string; code?: string; error?: string; error_description?: string }): Promise<{ ok: boolean; message: string }> {
  const p = q.state ? pending.get(q.state) : undefined;
  if (!p || p.expiresAt < app.now()) return { ok: false, message: "This sign-in expired. Start it again from Customize." };
  pending.delete(q.state!);
  if (q.error || !q.code) return { ok: false, message: `${p.name}: ${q.error_description || q.error || "no code came back"}` };
  try {
    const row = serverRow(app, p.name) ?? fail("not_found", `${p.name} was removed`);
    const sealed = await open(app, row);
    const o = sealedOf(sealed, p.name);
    o.tokens = await tokenRequest(app, o, { grant_type: "authorization_code", code: q.code, code_verifier: p.verifier });
    if (!(await saveOAuth(app, p.name, "signed_in", sealed, true, row.secrets_enc))) fail("failed", `${p.name} changed during the sign-in; start it again`);
    return { ok: true, message: `Signed in to ${p.name}. Agents get its tools from their next turn. You can close this tab.` };
  } catch (e) {
    const why = e instanceof AppFail ? e.error.message : e instanceof GrantGone ? `the server refused the code (${e.message})` : "something went wrong";
    return { ok: false, message: `${p.name}: ${why}` };
  }
}

export interface AccessToken {
  authorization: string;
  expiresAt: number | null;
}

/**
 * A current access token for an agent's bridge (`mcp_token`). `stale` is a token the server just refused: when it is still the saved
 * one, it is refreshed even if it has not expired yet. A grant that is gone signs the server out (Customize offers the sign-in again).
 */
export function mcpAccessToken(app: App, name: unknown, stale?: unknown): Promise<AccessToken> {
  if (typeof name !== "string") fail("invalid", "name is required");
  const running = refreshing.get(name);
  if (running) return running;
  const p = accessToken(app, name, typeof stale === "string" ? stale : undefined).finally(() => refreshing.delete(name));
  refreshing.set(name, p);
  return p;
}

async function accessToken(app: App, name: string, stale: string | undefined): Promise<AccessToken> {
  const row = serverRow(app, name);
  if (!row || row.oauth !== "signed_in") fail("not_configured", `Sign in to ${name} in Customize.`);
  const sealed = await open(app, row);
  const o = sealedOf(sealed, name);
  const t = o.tokens;
  const fresh = t && t.access !== stale && (t.expiresAt === null || t.expiresAt - MARGIN_MS > app.now());
  if (fresh) return { authorization: `Bearer ${t.access}`, expiresAt: t.expiresAt };
  if (!t?.refresh) return signOut(app, name, sealed, row.secrets_enc, "its token expired");
  let tokens: NonNullable<OAuthSealed["tokens"]>;
  try {
    tokens = await tokenRequest(app, o, { grant_type: "refresh_token", refresh_token: t.refresh });
  } catch (e) {
    if (e instanceof GrantGone) return signOut(app, name, sealed, row.secrets_enc, "its sign-in was revoked or expired");
    throw e;
  }
  await commitTokens(app, name, t.refresh, tokens);
  return { authorization: `Bearer ${tokens.access}`, expiresAt: tokens.expiresAt };
}

/**
 * Saves refreshed tokens onto the row as it is now. An edit made during the request (a header, say) is kept; a sign-out, a new
 * sign-in or a removal wins, and the refreshed tokens are dropped.
 */
async function commitTokens(app: App, name: string, usedRefresh: string, tokens: NonNullable<OAuthSealed["tokens"]>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const row = serverRow(app, name);
    if (row?.oauth !== "signed_in") break;
    const sealed = await open(app, row);
    if (sealed.oauth?.tokens?.refresh !== usedRefresh) break;
    sealed.oauth.tokens = tokens;
    if (await saveOAuth(app, name, "signed_in", sealed, false, row.secrets_enc)) return;
  }
  fail("not_configured", `${name} was signed out or changed. Sign in again in Customize.`);
}

async function signOut(app: App, name: string, sealed: McpServerSealed, from: string, why: string): Promise<never> {
  if (sealed.oauth) delete sealed.oauth.tokens;
  await saveOAuth(app, name, "signed_out", sealed, false, from);
  fail("not_configured", `${name}: ${why}. Sign in again in Customize.`);
}

/** Forgets the tokens (the registration stays, so the next sign-in is one click); agents drop the server. */
export async function signOutMcp(app: App, name: string): Promise<void> {
  const row = serverRow(app, name) ?? fail("not_found", "no such server");
  if (!row.oauth) fail("invalid", `${name} has no sign-in`);
  const sealed = await open(app, row);
  if (sealed.oauth) delete sealed.oauth.tokens;
  if (!(await saveOAuth(app, name, "signed_out", sealed, true, row.secrets_enc))) fail("failed", `${name} changed meanwhile; try again`);
}

/** The page the browser lands on after a sign-in. Static text, nothing from the query echoed unescaped. */
export function callbackPage(r: { ok: boolean; message: string }): string {
  const esc = r.message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${r.ok ? "Signed in" : "Sign-in failed"}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;background:#fafafa;color:#171717;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem}h1{font-size:15px;font-weight:500;margin:0 0 .5rem}p{margin:0;color:#525252}@media(prefers-color-scheme:dark){body{background:#171717;color:#fafafa}p{color:#a3a3a3}}</style>
<main><h1>${r.ok ? "Signed in" : "Sign-in failed"}</h1><p>${esc}</p></main>`;
}
