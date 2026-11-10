import { agentModelChoice, type AgentModelChoice } from "@dorks/shared";
import { z } from "zod";
import { fail, touch, type App } from "../app";
import type { DorkRow } from "../data";
import { enqueueConfigure, isAwake, patchDork } from "../lifecycle/dispatch";
import { owned } from "./dorks";

// The Claude model and effort a dork runs with. The choices are the ones the CLI itself offers the account (its `initialize` answer,
// relayed by the bridge as `agent_models`), never a list kept here. The last list any dork reported is remembered globally, so a new
// session can offer it before its sandbox exists.

const CACHE_KEY = "claude_model_choices";

export function rememberModelChoices(app: App, models: AgentModelChoice[]) {
  if (!models.length) return;
  const value = JSON.stringify(models);
  const before = app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", CACHE_KEY)?.value;
  if (before === value) return;
  app.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", CACHE_KEY, value);
  touch(app, { t: "settings" });
}

/** The last model list a Claude agent reported, or `[]` before any did. */
export function knownModelChoices(app: App): AgentModelChoice[] {
  const raw = app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", CACHE_KEY)?.value;
  if (!raw) return [];
  try {
    const parsed = z.array(agentModelChoice).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Checks a model/effort pair against the choices the agent offered. `model` null or "" means the CLI's default; effort null means
 * the model's default effort. Returns the values to store.
 */
export function validModelChoice(choices: AgentModelChoice[], model: unknown, effort: unknown): { model?: string; effort?: string } {
  if (model !== undefined && model !== null && typeof model !== "string") fail("invalid", "model must be a string");
  if (effort !== undefined && effort !== null && typeof effort !== "string") fail("invalid", "effort must be a string");
  const m = model || undefined;
  const e = effort || undefined;
  if (!m && !e) return {};
  const choice = choices.find((c) => c.model === (m ?? "default"));
  if (!choice) fail("invalid", m ? `${m} is not offered by the agent` : "the agent has not reported its models yet");
  if (e && !choice.efforts.includes(e as never)) fail("invalid", `${choice.name} does not support ${e} effort`);
  return { model: m, effort: e };
}

const choicesFor = (app: App, dork: DorkRow) => (dork.modelChoices?.length ? dork.modelChoices : knownModelChoices(app));

/**
 * Stores the choice and, when the sandbox is up, asks the bridge to reconfigure: it restarts the CLI on the same session with the
 * new flags once the current turn is over. Asleep, the choice is used on the next wake. `agentModel` is cleared until the agent
 * confirms the new one in its next init event.
 */
export function chooseModel(app: App, dorkId: string, model: unknown, effort: unknown) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    if (dork.archived) fail("archived", "dork is archived");
    if (dork.provider !== "claude") fail("invalid", "choose a Codex model from the thread");
    const next = validModelChoice(choicesFor(app, dork), model, effort);
    if (next.model === dork.model && next.effort === dork.effort) return;
    patchDork(app, dorkId, { model: next.model, effort: next.effort, agentModel: undefined, agentEffort: undefined });
    if (isAwake(dork.state)) {
      // A pending configure may already have been fetched with the previous choice: replace it, so the bridge (which dedupes by
      // command id) fetches the configuration again. An ack for the dropped row is ignored.
      app.db.run("DELETE FROM commands WHERE dork_id = ? AND kind = 'configure' AND acked = 0", dorkId);
      enqueueConfigure(app, dorkId);
    }
  });
}
