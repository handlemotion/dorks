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

function docs(request: Request, url: URL, env: Env): Promise<Response> | Response {
  if (env.DOCS_PROXY !== "true") {
    // Before Mintlify knows the /docs base path its pages live at the site root.
    const path = url.pathname.replace(/^\/docs/, "") || "/";
    return Response.redirect(`https://${env.DOCS_HOST}${path}${url.search}`, 302);
  }
  const upstream = new URL(url);
  upstream.hostname = env.DOCS_HOST;
  const proxied = new Request(upstream, request);
  proxied.headers.set("Host", env.DOCS_HOST);
  proxied.headers.set("X-Forwarded-Host", url.hostname);
  proxied.headers.set("X-Forwarded-Proto", "https");
  return fetch(proxied, { redirect: "manual" });
}
