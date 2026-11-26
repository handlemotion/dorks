import type { App } from "../app";
import type { Provider } from "../data";
import { ANTIGRAVITY_SECRETS, readSettings, secretNames } from "./settings";

/**
 * What a new session still needs, in onboarding order (Boat, agent, GitHub, then the one thing set up without a step: the base
 * snapshot), or null when nothing is missing. The one gate `createDork` applies, so a session that cannot start
 * is refused with a clear reason instead of created and failed in the background.
 */
export function missingForSession(app: App, provider: Provider): string | null {
  const s = readSettings(app);
  const sim = app.cfg.boxProvider === "sim";
  if (!sim && !s.boatKeyEnc) return "Connect Boat first: sign in to Boat in the setup list under the message box.";
  if (provider === "claude" && !s.claudeTokenEnc) return "Connect Claude Code first: add your Claude token.";
  if (provider === "antigravity" && !s.antigravityTokenEnc && !secretNames(app).some((n) => ANTIGRAVITY_SECRETS.includes(n))) return "Connect Antigravity first: sign in with Google in Settings.";
  if (provider === "codex" && !sim && !s.boatEnvironment) return "Connect Codex first: connect ChatGPT once in Boat and select your Boat environment in Settings.";
  if (!s.githubConnected) return "Connect GitHub first: sign in with the GitHub CLI.";
  if (!(s.baseSnapshotId ?? app.cfg.baseSnapshotId)) return "Boat is still being prepared: wait for the base snapshot, or retry it if it failed.";
  return null;
}
