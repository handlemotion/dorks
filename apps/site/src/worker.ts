/** The edge for dorks.build: www goes to the apex, the docs come from Mintlify, everything else is the static site. */
interface Env {
  ASSETS: Fetcher;
  DOCS_HOST: string;
  DOCS_PROXY?: string;
}

const APEX = "dorks.build";
/** Mintlify at a subpath needs its own asset and API paths too (mintlify.com/docs/deploy/cloudflare). */
const DOCS_PATH = /^\/(?:docs(?:\/|$)|_mintlify\/|mintlify-assets\/)/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }
    if (DOCS_PATH.test(url.pathname)) return docs(request, url, env);
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
