import { planOf, type PlanId } from "@dorks/shared";
import { touch, type App } from "../app";

// The plan of this server's workspace (docs/cloud.md, "Plans"), and what it allows. Dorks Free (`local`) runs chats on this Mac only:
// no sandboxes, since a sandbox driven by a Mac stops with the Mac, which defeats the point of having one. Sandboxes are Dorks Teams'
// and Dorks Cloud's, whose workspaces run in the cloud. A server Dorks runs for an org (`DORKS_ORG_ID`) is always a paid one.
// `DORKS_SANDBOXES_WITHOUT_PLAN=1` lifts the rule for development, the e2e and self-hosting.

const META = "cloud_plan";

const ownOrg = (app: App) => app.db.get<{ cloud_org_id: string | null }>("SELECT cloud_org_id FROM settings WHERE id = 1")?.cloud_org_id ?? null;

/** The plan the cloud last named, with the org it named it for. */
function cached(app: App): { org: string; plan: PlanId } | null {
  const r = app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", META);
  try {
    const v = r ? (JSON.parse(r.value) as { org?: unknown; plan?: unknown }) : null;
    const plan = planOf(v?.plan);
    return v && typeof v.org === "string" && plan ? { org: v.org, plan } : null;
  } catch {
    return null;
  }
}

/**
 * This workspace's plan: what the cloud last said about the org this server serves now, else Dorks Free (signed out, unpaired, or a
 * plan cached for an org it no longer serves).
 */
export function serverPlan(app: App): PlanId {
  if (app.cfg.orgId) return "teams";
  const own = ownOrg(app);
  const c = cached(app);
  return own && c?.org === own ? c.plan : "local";
}

/**
 * Called with the account's orgs whenever they are read (`GET /api/cloud/places`): keeps this server's plan current. Its own org
 * missing from them (left, deleted) is Free. A change tells clients to read the settings again (where sandboxes are offered).
 */
export function rememberPlan(app: App, orgs: { id: string; plan: PlanId | null }[]) {
  const own = ownOrg(app);
  if (!own) return;
  const before = serverPlan(app);
  const plan = orgs.find((o) => o.id === own)?.plan ?? "local";
  app.db.tx(() => {
    app.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", META, JSON.stringify({ org: own, plan }));
    if (plan !== before) touch(app, { t: "settings" });
  });
}

export const NO_SANDBOXES = "Sandboxes need Dorks Teams or Dorks Cloud. On Dorks Free, chats run on this Mac.";

/** Where a session runs when nobody said: a sandbox, or this Mac on Dorks Free. */
export const defaultLocationOf = (app: App): "cloud" | "local" => (sandboxes(app).available ? "cloud" : "local");

/** Whether sessions may run in sandboxes here, and why not. */
export function sandboxes(app: App): { available: boolean; reason?: string } {
  if (app.cfg.sandboxesWithoutPlan || serverPlan(app) !== "local") return { available: true };
  return { available: false, reason: NO_SANDBOXES };
}
