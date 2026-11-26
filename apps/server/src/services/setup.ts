import type { DorkLocation } from "@dorks/shared";
import type { App } from "../app";
import type { Provider } from "../data";
import { ANTIGRAVITY_SECRETS, readSettings, secretNames } from "./settings";

/**
 * What a new session still needs, in onboarding order (Boat, agent, GitHub, then the one thing set up without a step: the base
 * snapshot), or null when nothing is missing. The one gate `createDork` applies, so a session that cannot start
 * is refused with a clear reason instead of created and failed in the background.
 */
export function missingForSession(app: App, provider: Provider, location: DorkLocation = "cloud"): string | null {
  const s = readSettings(app);
  // A local session runs on this computer (docs/local-dorks.md): no Boat, no snapshot, no Boat environment; the agent and GitHub still.
  const noBoat = app.cfg.boxProvider === "sim" || location === "local";
  if (!noBoat && !s.boatKeyEnc) return "Connect Boat first: sign in to Boat in the setup list under the message box.";
  if (provider === "claude" && !s.claudeTokenEnc) return "Connect Claude Code first: add your Claude token.";
  if (provider === "antigravity" && !s.antigravityTokenEnc && !secretNames(app).some((n) => ANTIGRAVITY_SECRETS.includes(n))) return "Connect Antigravity first: sign in with Google in Settings.";
  if (provider === "codex" && !noBoat && !s.boatEnvironment) return "Codex is optional: connect ChatGPT once in Boat and select your Boat environment in Settings, or use Claude Code.";
  if (!s.githubConnected) return "Connect GitHub first: sign in with the GitHub CLI.";
  if (location === "cloud" && !(s.baseSnapshotId ?? app.cfg.baseSnapshotId)) return "Boat is still being prepared: wait for the base snapshot, or retry it if it failed.";
  return null;
}
