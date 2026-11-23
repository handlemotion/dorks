import { imageBytes } from "../../services/bridge";
import { imageThumb, thumbWidth } from "../../services/imageThumbs";
import { CALLBACK_PATH, callbackPage, finishMcpSignIn } from "../../services/mcpOAuth";
import { errBody } from "../route";
import type { Routes } from "./shared";

// The routes that need no owner token. Registered before the auth middleware.
export const publicRoutes: Routes = (api, app) => {
  api.get("/api/health", (c) => c.json({ ok: true }));

  // The simulator's stand-in for a Boat desktop stream (lib/box.ts simBox): a static page, no data, so it needs no token.
  if (app.cfg.boxProvider === "sim") api.get("/sim/desktop", (c) => c.html(simDesktopPage(c.req.query("theme") === "dark")));

  // A screenshot the agent shared (screenshot_share). Outside /api so a plain <img> can load it: the 128-bit random id is the
  // capability, handed out only inside the owner's transcript. Immutable, never sniffed, never run as a document.
  // `?w=640`: a smaller WebP copy for thumbnails (services/imageThumbs.ts), the original when none can be made.
  api.get("/images/:id", async (c) => {
    const id = c.req.param("id");
    const width = thumbWidth(c.req.query("w"));
    const img = width && /^[0-9a-f]{32}$/.test(id) ? await imageThumb(app, id, width) : imageBytes(app, id);
    if (!img) return c.json(errBody({ code: "not_found", message: "not found" }), 404);
    return new Response(img.bytes, {
      headers: {
        "content-type": img.mime,
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  });

  // Where a remote MCP server's sign-in sends the browser back (services/mcpOAuth.ts). No token: the single-use, random `state` from
  // the owner's own sign-in request is the capability.
  api.get(CALLBACK_PATH, async (c) => {
    const r = await finishMcpSignIn(app, c.req.query());
    return c.html(callbackPage(r), r.ok ? 200 : 400, { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "referrer-policy": "no-referrer" });
  });
};

function simDesktopPage(dark: boolean): string {
  const [bg, fg, bar] = dark ? ["#1d1f24", "#e6e6e6", "#2a2d33"] : ["#3a6ea5", "#1a1a1a", "#f2f2f2"];
  const window = `<div style="position:absolute;inset:8% 12% 14% 10%;background:#fff;border-radius:8px;overflow:hidden">
<div style="height:36px;background:${bar};display:flex;align-items:center;padding:0 12px;font:13px system-ui;color:${fg}">localhost:3000</div>
<div style="padding:32px;font:15px system-ui;color:#1a1a1a">Simulated sandbox screen. A real dork streams its Boat desktop here.</div></div>`;
  return `<!doctype html><meta charset="utf-8"><title>Simulated desktop</title><body style="margin:0;height:100vh;background:${bg};position:relative;overflow:hidden">${window}</body>`;
}
