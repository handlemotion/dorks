// Dorks plans (docs/cloud.md, "Plans"). A plan belongs to an organization:
// - `local`: Dorks Free, your personal org on your own Mac;
// - `teams`: Dorks Teams, one price per org: the org runs in the cloud (shared chats, automations around the clock) with a monthly
//   allowance for production-like testing; sandboxes run on the team's own Boat key.
// The cloud named them `free` and `collab` before, and had a `cloud` plan (Dorks Cloud, now retired): those still read as `local` and
// `teams`.

export const PLANS = ["local", "teams"] as const;
export type PlanId = (typeof PLANS)[number];

const LEGACY: Record<string, PlanId> = { free: "local", collab: "teams", cloud: "teams" };

/** A plan id from the cloud (a token claim, an org row), the older names included; null for anything else. */
export function planOf(raw: unknown): PlanId | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return (PLANS as readonly string[]).includes(id) ? (id as PlanId) : (LEGACY[id] ?? null);
}

/** What a plan is called in the app. */
// `local` is the plan's id (it runs on your Mac); the plan is called Free. "Local" names where a chat runs, on any plan.
export const PLAN_NAMES: Record<PlanId, string> = { local: "Dorks Free", teams: "Dorks Teams" };

/** One line on what the org gets, for Settings › Organization. */
export const PLAN_SUMMARIES: Record<PlanId, string> = {
  local: "Free: chats run on your Mac, and you can reach them from your phone while it is on.",
  teams: "One price for the organization: work together in real time, automations around the clock and production-like checks on every PR, with your own Boat key.",
};
