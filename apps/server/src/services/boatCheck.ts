import { fail, type App } from "../app";
import { BoatError, createBoatCall } from "../lib/boat";
import { boatKey, readSettings } from "./settings";

export type BoatCheckStatus = "ok" | "invalid" | "needs_org" | "credit_required" | "unreachable";
export interface BoatCheck {
  status: BoatCheckStatus;
  message: string;
}

/**
 * Asks Boat for one sandbox with the given key (or the saved one), the cheapest authenticated call, so a wrong key or a missing
 * organization is reported on the Boat step instead of as a failed "Prepare Boat". Nothing is saved here.
 */
export async function checkBoat(app: App, input: { boatKey?: unknown; boatOrg?: unknown }): Promise<BoatCheck> {
  if (input.boatKey !== undefined && typeof input.boatKey !== "string") fail("invalid", "Boat API key must be a string");
  if (input.boatOrg !== undefined && typeof input.boatOrg !== "string") fail("invalid", "Boat organization must be a string");
  const apiKey = input.boatKey?.trim() || (await boatKey(app));
  if (!apiKey) fail("not_configured", "Add your Boat API key first.");
  const org = input.boatOrg !== undefined ? input.boatOrg.trim() || undefined : readSettings(app).boatOrg;
  if (app.cfg.boxProvider === "sim") return { status: "ok", message: "Simulated sandboxes: nothing to check." };
  try {
    await createBoatCall({ apiKey, org, fetch: app.fetch })("check key", "GET", "/sandboxes?limit=1", undefined, {}, 15_000);
    return { status: "ok", message: "Boat accepted the key." };
  } catch (e) {
    if (!(e instanceof BoatError)) throw e;
    if (e.status === 402 || e.code === "credit_required") return { status: "credit_required", message: "Boat accepted the key but the account has no credit. Add credit or start a plan in Boat." };
    if ((e.status === 400 || e.status === 403) && /org/i.test(e.code ?? "")) {
      return { status: "needs_org", message: org ? "That key cannot use this organization. Check the organization id." : "This key belongs to an organization. Enter the organization id." };
    }
    if (e.status === 401 || e.status === 403) return { status: "invalid", message: "Boat rejected that key. Check it and its access (create, list, use and delete sandboxes)." };
    return { status: "unreachable", message: "Could not reach Boat. Check your connection and try again." };
  }
}
