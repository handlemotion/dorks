import { Hono } from "hono";
import { cors } from "hono/cors";
import { AppFail, type App } from "../app";
import { errBody, STATUS } from "./route";
import { mountMcp } from "./mcp";
import { safeEqual } from "./ui/shared";
import { publicRoutes } from "./ui/public";
import { dorkRoutes } from "./ui/dorks";
import { pullRoutes } from "./ui/pulls";
import { localRoutes } from "./ui/local";
import { subscriptionRoutes } from "./ui/subscriptions";
import { commentRoutes } from "./ui/comments";
import { fileRoutes } from "./ui/files";
import { workspaceRoutes } from "./ui/workspace";
import { settingsRoutes } from "./ui/settings";
import { customizeRoutes } from "./ui/customize";
import { accountRoutes } from "./ui/accounts";
import { buildRoutes } from "./ui/builds";
import { automationRoutes } from "./ui/automations";
import { liveRoutes, simFeedRoutes } from "./ui/live";
import { phoneRoutes } from "./ui/phone";
import { teamRoutes } from "./ui/team";
import { cloudRoutes } from "./ui/cloud";

/** The loopback API the UI talks to (docs/architecture.md, "UI API"). Owner-token bearer auth on everything except /api/health. */
export function uiApp(app: App): Hono {
  const api = new Hono();

  api.use(
    "*",
    cors({
      origin: (origin) => (app.cfg.uiOrigins.includes(origin) ? origin : null),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );

  publicRoutes(api, app);

  api.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const header = c.req.header("authorization");
    const presented = header?.startsWith("Bearer ") ? header.slice(7) : c.req.path === "/api/live" ? c.req.query("access_token") : undefined;
    if (!presented || !safeEqual(presented, app.cfg.ownerToken)) return c.json(errBody({ code: "forbidden", message: "forbidden" }), 401);
    return next();
  });

  api.onError((e, c) => {
    if (e instanceof AppFail) return c.json(errBody(e.error), STATUS[e.error.code] as 400);
    console.error("ui request failed", c.req.method, c.req.path, e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return c.json(errBody({ code: "failed", message: "Something went wrong" }), 500);
  });

  // The owner's other agents reach dorks over MCP (http/mcp.ts, docs/crew.md); it checks the owner token itself.
  mountMcp(api, app);

  // Registration order is the original single-file order; the auth middleware above covers every /api route below.
  for (const routes of [
    dorkRoutes,
    pullRoutes,
    localRoutes,
    subscriptionRoutes,
    commentRoutes,
    fileRoutes,
    workspaceRoutes,
    settingsRoutes,
    customizeRoutes,
    accountRoutes,
    buildRoutes,
    automationRoutes,
    phoneRoutes,
    teamRoutes,
    cloudRoutes,
    liveRoutes,
    simFeedRoutes,
  ])
    routes(api, app);

  return api;
}
