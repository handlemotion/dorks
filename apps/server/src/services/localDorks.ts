import type { Context } from "hono";
import type { DorkLocation, LocalAvailability } from "@dorks/shared";
import { fail, type App } from "../app";
import type { DorkRow } from "../data";
import { AGENT_BINS, AGENT_NAMES, findOn, localTools, nodeMajor } from "../lib/localTools";
import { actorOf, localOwner, type Actor } from "./team";

// Who may run local dorks, and whether this computer can (docs/local-dorks.md). A local dork runs the owner's own CLIs on this computer,
// unsandboxed, so only its owner may start or drive one: at the computer, or from their own phone through the relay (the paired phone,
// or a request whose verified identity is the person who paired this computer). Never a teammate, and never on a server that runs in
// the cloud for an organization.

/** This computer's owner: here, on their paired phone, or signed in to Dorks Cloud as the person who paired it. */
export function isOwner(app: App, actor: Actor) {
  if (actor.kind === "local" || actor.kind === "phone") return true;
  const owner = localOwner(app);
  return !!owner && actor.member.id === owner.id;
}

const MIN_NODE = 22;
let nodeChecked: { node: string | null; major: number | null } | undefined;

/** Whether local dorks can be offered to this actor. Cheap and synchronous: the tools are checked when a session starts. */
export function localAvailability(app: App, actor: Actor): LocalAvailability {
  if (app.cfg.localDorks === false) return { available: false, reason: "Local sessions are turned off on this server." };
  if (app.cfg.orgId) return { available: false, reason: "This server runs in the cloud, so its sessions do too." };
  if (process.platform === "win32") return { available: false, reason: "Local sessions need macOS or Linux." };
  if (!isOwner(app, actor)) return { available: false, reason: "Local sessions run on their owner’s computer: only they can start one." };
  if (nodeChecked && (!nodeChecked.node || (nodeChecked.major ?? 0) < MIN_NODE)) return { available: false, reason: `Install Node.js ${MIN_NODE} or later to run sessions on this computer.` };
  return { available: true };
}

/** The settings' `local` field for a request. */
export const localAvailabilityOf = (c: Context, app: App) => localAvailability(app, actorOf(c));

/**
 * A local session can start now: this actor may start one, and Node.js and the agent's CLI are installed. Refuses in plain words
 * otherwise. Async (it reads the login shell's PATH once), so the route runs it before `createDork`.
 */
export async function assertLocalReady(app: App, actor: Actor, provider: string): Promise<void> {
  const tools = await localTools(app.cfg.localNodeBin);
  nodeChecked = { node: tools.node, major: tools.node ? await nodeMajor(tools.node) : null };
  const can = localAvailability(app, actor);
  if (!can.available) fail(isOwner(app, actor) ? "not_configured" : "forbidden", can.reason ?? "Local sessions are not available.");
  const bin = AGENT_BINS[provider] ?? provider;
  if (!findOn(tools.path, bin))
    fail("not_configured", `${AGENT_NAMES[provider] ?? provider} isn’t installed on this computer (no \`${bin}\` on your PATH). Install it, or run the session in the cloud.`);
}

/** The location a new session asks for: `local` or `cloud` (default). */
export function locationOf(input: unknown): DorkLocation {
  if (input === undefined || input === null || input === "" || input === "cloud") return "cloud";
  if (input === "local") return "local";
  return fail("invalid", "location must be cloud or local");
}

/**
 * A relayed client (the phone, a teammate) may read a local dork but not drive it: a message would run the owner's CLIs on this
 * computer, unsandboxed, from somewhere else.
 */
export function assertMayDrive(app: App, actor: Actor, dork: Pick<DorkRow, "location">) {
  if (dork.location === "local" && !isOwner(app, actor)) fail("forbidden", "This session runs on its owner’s computer. Only they can continue it.");
}
