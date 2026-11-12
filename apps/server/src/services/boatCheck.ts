import { fail, type App } from "../app";
import { BoatError, checkCodexEnvironment, createBoatCall } from "../lib/boat";
import { boatKey, readSettings } from "./settings";

export type BoatCheckStatus = "ok" | "invalid" | "needs_org" | "credit_required" | "unreachable";
export interface BoatCheck {
  status: BoatCheckStatus;
  message: string;
}

const TIMEOUT_MS = 15_000;

/**
 * Whether Boat will run Dorks' sandboxes with this key (or the saved one), asked before anything is saved, so the Boat step
 * reports a wrong key, a free trial or an empty wallet instead of a failed snapshot build minutes later.
 *
 * `GET /limits` (https://docs.boat.dev/api/reference/account/get-boat-limits) answers it in one call: `sandboxPlanKey` is `trial`
 * before the first payment, and `canStart` says whether the account can create sandboxes now. It needs the key's `account.read`
 * action; a key without it (403 `api_key_action_forbidden`) is checked with `GET /sandboxes?limit=1` instead, which proves the key
 * but not the plan.
 */
export async function checkBoat(app: App, input: { boatKey?: unknown; boatOrg?: unknown }): Promise<BoatCheck> {
  if (input.boatKey !== undefined && typeof input.boatKey !== "string") fail("invalid", "Boat API key must be a string");
  if (input.boatOrg !== undefined && typeof input.boatOrg !== "string") fail("invalid", "Boat organization must be a string");
  const apiKey = input.boatKey?.trim() || (await boatKey(app));
  if (!apiKey) fail("not_configured", "Add your Boat API key first.");
  const org = input.boatOrg !== undefined ? input.boatOrg.trim() || undefined : readSettings(app).boatOrg;
  if (app.cfg.boxProvider === "sim") return { status: "ok", message: "Simulated sandboxes: nothing to check." };
  try {
    return await askBoat(createBoatCall({ apiKey, org, fetch: app.fetch }));
  } catch (e) {
    if (!(e instanceof BoatError)) throw e;
    return failureOf(e, !!org);
  }
}

const ACCEPTED: BoatCheck = { status: "ok", message: "Boat accepted the key." };

/** `GET /limits`, or `GET /sandboxes?limit=1` for a key without `account.read`. Boat failures are thrown as `BoatError`. */
async function askBoat(call: ReturnType<typeof createBoatCall>): Promise<BoatCheck> {
  let limits: { sandboxPlanKey?: unknown; canStart?: unknown; startBlockedReason?: unknown };
  try {
    limits = await call("check key", "GET", "/limits", undefined, {}, TIMEOUT_MS);
  } catch (e) {
    if (!(e instanceof BoatError) || e.code !== "api_key_action_forbidden") throw e;
    await call("check key", "GET", "/sandboxes?limit=1", undefined, {}, TIMEOUT_MS);
    return ACCEPTED;
  }
  // The trial forces auto-stop within 2 hours and cannot save snapshots (https://docs.boat.dev/free-trial): Dorks cannot run on it.
  if (limits?.sandboxPlanKey === "trial")
    return { status: "credit_required", message: "Dorks needs a paid Boat plan: the free trial cannot save the snapshot sessions start from. End the trial in Boat, then continue." };
  if (limits?.canStart === false) {
    const reason = typeof limits.startBlockedReason === "string" && limits.startBlockedReason ? ` (${limits.startBlockedReason.slice(0, 120)})` : "";
    return { status: "credit_required", message: `Boat cannot start sandboxes on this account right now${reason}. Add funds or fix billing in Boat, then continue.` };
  }
  return ACCEPTED;
}

/** Boat's documented error codes (https://docs.boat.dev/api/v1, "Error model") in plain words for the Boat step. */
function failureOf(e: BoatError, withOrg: boolean): BoatCheck {
  if (e.code === "api_key_expired") return { status: "invalid", message: "That Boat API key has expired. Create a new one in Boat." };
  if (e.code === "org_suspended") return { status: "credit_required", message: "This Boat organization's wallet is suspended. Fix billing in Boat, then continue." };
  if (e.status === 402) return { status: "credit_required", message: "Boat accepted the key but the account has no credit. Add funds or start a plan in Boat." };
  if (withOrg && (e.code === "ambiguous_org" || e.status === 404 || e.status === 403))
    return { status: "needs_org", message: "That key cannot use this organization. Use the organization's team_… id from Boat." };
  if (e.status === 401 || e.status === 403) return { status: "invalid", message: "Boat rejected that key. Check it and its access (create, use, save and delete sandboxes)." };
  return { status: "unreachable", message: "Could not reach Boat. Check your connection and try again." };
}

/**
 * The server's own check on `PUT /api/settings`: a Boat key or organization is saved only if Boat accepts it, whatever the client
 * did first. Clearing the key, or changing the organization with no key saved, needs no check. Boat being unreachable does not
 * block the save (like the GitHub check): the snapshot build reports it then.
 */
export async function assertBoatAccepts(app: App, patch: { boatKey?: unknown; boatOrg?: unknown }): Promise<void> {
  const key = typeof patch.boatKey === "string" ? patch.boatKey.trim() : undefined;
  if (key === "" || (key === undefined && (patch.boatOrg === undefined || !readSettings(app).boatKeyEnc))) return;
  const check = await checkBoat(app, patch);
  if (check.status !== "ok" && check.status !== "unreachable") fail("invalid", check.message);
}

/**
 * `PUT /api/settings` with a Codex environment: checked against Boat on save (it exists, passes only the agent sign-in, uses a
 * named credential profile), so a wrong one is reported in setup rather than when a Codex session is created. Uses the Boat key
 * and organization from the same request, else the saved ones; without a key, or with Boat unreachable, it is saved unchecked
 * and the create job checks it again anyway.
 */
export async function assertCodexEnvironment(app: App, patch: { boatEnvironment?: unknown; boatKey?: unknown; boatOrg?: unknown }): Promise<void> {
  const name = typeof patch.boatEnvironment === "string" ? patch.boatEnvironment.trim() : "";
  if (!name || app.cfg.boxProvider === "sim") return;
  const apiKey = (typeof patch.boatKey === "string" && patch.boatKey.trim()) || (await boatKey(app));
  if (!apiKey) return;
  const org = typeof patch.boatOrg === "string" ? patch.boatOrg.trim() || undefined : readSettings(app).boatOrg;
  try {
    await checkCodexEnvironment(createBoatCall({ apiKey, org, fetch: app.fetch }), org, name);
  } catch (e) {
    if (!(e instanceof BoatError)) throw e;
    if (e.message.startsWith("boat: selected environment")) fail("invalid", `Boat: ${e.message.slice("boat: ".length)}.`);
    if (e.code === "api_key_action_forbidden") fail("invalid", "The Boat API key cannot read environments (environment.read). Give the key that action, then save again.");
    // unreachable or another Boat failure: saved; the create job checks again
  }
}
