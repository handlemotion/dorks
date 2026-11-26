import { fetchMacRelease, parseVersion, RELEASES_URL, type MacRelease } from "./lib/release";

/** The edge for dorks.build: www goes to the apex, /download is the Mac app, the docs come from Mintlify, everything else is the static site. */
interface Env {
  ASSETS: Fetcher;
  DOCS_HOST: string;
  DOCS_PROXY?: string;
}

const APEX = "dorks.build";
/** /invite/<id> is one static page (src/pages/invite.astro) that reads the id from the address. */
const INVITE_PATH = /^\/invite\/[^/]+\/?$/;
/** /download (the latest .dmg), /download/<version> (that one's), /download.json (the latest, for the site's buttons). */
const DOWNLOAD_PATH = /^\/download(?:\.json|\/[^/]*)?\/?$/;
/** How long a lookup of GitHub's latest release is reused. Unauthenticated GitHub API calls are rate limited per IP. */
const LATEST_TTL = 300;
const VERSION_TTL = 86_400;
/** Mintlify at a subpath needs its own asset and API paths too (mintlify.com/docs/deploy/cloudflare). */
const DOCS_PATH = /^\/(?:docs(?:\/|$)|_mintlify\/|mintlify-assets\/)/;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }
    if (DOWNLOAD_PATH.test(url.pathname)) return download(request, url, env, ctx);
    if (DOCS_PATH.test(url.pathname)) return docs(request, url, env);
    if (INVITE_PATH.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL("/invite/", url), request));
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function docs(request: Request, url: URL, env: Env): Promise<Response> {
  if (env.DOCS_PROXY !== "true") {
    // Before Mintlify knows the /docs base path its pages live at the site root.
    const path = url.pathname.replace(/^\/docs/, "") || "/";
    return Response.redirect(`https://${env.DOCS_HOST}${path}${url.search}`, 302);
  }
  const upstream = new URL(url);
  upstream.protocol = "https:";
  upstream.hostname = env.DOCS_HOST;
  // A local preview's port (wrangler dev) must not reach Mintlify.
  upstream.port = "";
  // Mintlify serves the docs' home page at /docs/index; /docs itself is a 404 there.
  if (upstream.pathname === "/docs") upstream.pathname = "/docs/index";
  const proxied = new Request(upstream, request);
  proxied.headers.set("Host", env.DOCS_HOST);
  proxied.headers.set("X-Forwarded-Host", url.hostname);
  proxied.headers.set("X-Forwarded-Proto", "https");
  const response = await fetch(proxied, { redirect: "manual" });
  return keepOnSite(response, url, env.DOCS_HOST);
}

/** Mintlify's redirects name its own host (/docs/ -> https://<DOCS_HOST>/docs): send the visitor to the same path here instead. */
function keepOnSite(response: Response, url: URL, docsHost: string): Response {
  const location = response.headers.get("Location");
  if (!location) return response;
  const target = new URL(location, url);
  if (target.hostname !== docsHost) return response;
  target.protocol = url.protocol;
  target.host = url.host;
  const headers = new Headers(response.headers);
  headers.set("Location", target.toString());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function download(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const path = url.pathname.replace(/\/$/, "");
  const json = path === "/download.json";
  const segment = decodeURIComponent(path.slice("/download/".length));
  const requested = path === "/download" || json || segment === "latest" ? "latest" : parseVersion(segment);
  if (!requested) return notFound(url, env);
  let release: MacRelease | null;
  try {
    release = await cachedRelease(requested, ctx);
  } catch (error) {
    // GitHub is down or rate limiting us: the release page is still one click from the file.
    console.error("download: GitHub lookup failed", error);
    if (json) return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    const page = requested === "latest" ? `${RELEASES_URL}/latest` : `${RELEASES_URL}/tag/desktop-v${requested}`;
    return redirect(page, "no-store");
  }
  if (!release) return json ? Response.json({ error: "not found" }, { status: 404 }) : notFound(url, env);
  const cacheControl = `public, max-age=${requested === "latest" ? 60 : VERSION_TTL}`;
  if (json) return Response.json(release, { headers: { "Cache-Control": cacheControl, "Access-Control-Allow-Origin": "*" } });
  return redirect(release.url, cacheControl);
}

function redirect(location: string, cacheControl: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": cacheControl } });
}

async function notFound(url: URL, env: Env): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL("/404.html", url));
  return new Response(page.body, { status: 404, headers: page.headers });
}

/** GitHub's answer for a release, kept in the colo's cache: the latest for LATEST_TTL, a version for VERSION_TTL. */
async function cachedRelease(version: string, ctx: ExecutionContext): Promise<MacRelease | null> {
  const key = new Request(`https://dorks.build/_cache/release/${version}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as MacRelease | null;
  const release = await fetchMacRelease(version);
  // A missing version is cached briefly too, so a bad link can't spend the rate limit.
  const ttl = version === "latest" || !release ? LATEST_TTL : VERSION_TTL;
  ctx.waitUntil(cache.put(key, Response.json(release, { headers: { "Cache-Control": `public, max-age=${ttl}` } })));
  return release;
}
