import type { App } from "../app";
import type { Provider } from "../data";
import { readSettings } from "./settings";

/**
 * What a new session still needs, in onboarding order (Boat, agent, GitHub, then the two things set up without a step: the base
 * snapshot and the public URL), or null when nothing is missing. The one gate `createDork` applies, so a session that cannot start
 * is refused with a clear reason instead of created and failed in the background.
 */
export function missingForSession(app: App, provider: Provider): string | null {
  const s = readSettings(app);
  const sim = app.cfg.boxProvider === "sim";
  if (!sim && !s.boatKeyEnc) return "Connect Boat first: add your Boat API key.";
  if (provider === "claude" && !s.claudeTokenEnc) return "Connect Claude Code first: add your Claude token.";
  if (provider === "codex" && !sim && !s.boatEnvironment) return "Codex is optional: connect ChatGPT once in Boat and select your Boat environment in Settings, or use Claude Code.";
  if (!s.githubTokenEnc) return "Connect GitHub first: add a GitHub token.";
  if (!(s.baseSnapshotId ?? app.cfg.baseSnapshotId)) return "Boat is still being prepared: wait for the base snapshot, or retry it if it failed.";
  if (!sim && !app.cfg.publicUrl) return "Set up the public URL that sandboxes use to reach this app first.";
  return null;
}
