import { agentModelChoice, modelValue, type AgentModelChoice } from "@dorks/shared";
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

/**
 * Before any agent has reported its list, the CLI's own stable aliases, so the first session can already pick a model. The
 * efforts are left out (the default only) until the real list arrives and replaces this one.
 */
const FALLBACK_CHOICES: AgentModelChoice[] = [
  { model: "default", name: "Default", efforts: [] },
  { model: "opus", name: "Opus", efforts: [] },
  { model: "sonnet", name: "Sonnet", efforts: [] },
  { model: "haiku", name: "Haiku", efforts: [] },
];

/** The last model list a Claude agent reported, or the CLI's aliases before any did. */
export function knownModelChoices(app: App): AgentModelChoice[] {
  const raw = app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", CACHE_KEY)?.value;
  if (!raw) return FALLBACK_CHOICES;
  try {
    const parsed = z.array(agentModelChoice).safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.length ? parsed.data : FALLBACK_CHOICES;
  } catch {
    return FALLBACK_CHOICES;
  }
}

/**
 * Checks a model/effort/fast choice against the choices the agent offered. `model` null or "" means the CLI's default; effort null
 * means the model's default effort; `fast` absent or false is off. Returns the values to store.
 */
export function validModelChoice(choices: AgentModelChoice[], model: unknown, effort: unknown, fast?: unknown): { model?: string; effort?: string; fast: boolean } {
  for (const [name, v, type] of [
    ["model", model, "string"],
    ["effort", effort, "string"],
    ["fast", fast, "boolean"],
  ] as const)
    if (v !== undefined && v !== null && typeof v !== type) fail("invalid", `${name} must be a ${type}`);
  const m = (model as string | null | undefined) || undefined;
  const e = (effort as string | null | undefined) || undefined;
  const f = fast === true;
  if (!m && !e && !f) return { fast: false };
  const choice = choices.find((c) => c.model === (m ?? "default"));
  if (!choice) fail("invalid", m ? `${m} is not offered by the agent` : "the agent has not reported its models yet");
  if (e && !choice.efforts.includes(e as never)) fail("invalid", `${choice.name} does not support ${e} effort`);
  if (f && !choice.fast) fail("invalid", `${choice.name} does not offer fast mode`);
  return { model: m, effort: e, fast: f };
}

/**
 * An OpenCode model: `provider/model`, one its configured providers offered when the dork has reported them (`choices`), any
 * well-formed one before that (a first session names it before its sandbox exists; the bridge reports one OpenCode lacks as an issue).
 * Empty means OpenCode's own default. OpenCode has no efforts or fast mode here.
 */
export function validOpenCodeModel(choices: AgentModelChoice[] | undefined, model: unknown): { model?: string; fast: false } {
  if (model === undefined || model === null || model === "") return { fast: false };
  if (typeof model !== "string" || !modelValue.safeParse(model).success || !model.includes("/")) fail("invalid", "an OpenCode model is provider/model");
  if (choices?.length && !choices.some((c) => c.model === model)) fail("invalid", `${model} is not offered by OpenCode`);
  return { model, fast: false };
}

const choicesFor = (app: App, dork: DorkRow) => (dork.modelChoices?.length ? dork.modelChoices : knownModelChoices(app));

/**
 * Stores the choice and, when the sandbox is up, asks the bridge to reconfigure: it restarts the CLI on the same session with the
 * new flags once the current turn is over. Asleep, the choice is used on the next wake. `agentModel` is cleared until the agent
 * confirms the new one in its next init event.
 */
export function chooseModel(app: App, dorkId: string, model: unknown, effort: unknown, fast?: unknown) {
  app.db.tx(() => {
    const dork = owned(app, dorkId);
    if (dork.archived) fail("archived", "dork is archived");
    if (dork.provider === "codex") fail("invalid", "choose a Codex model from the thread");
    const next: { model?: string; effort?: string; fast: boolean } =
      dork.provider === "opencode" ? validOpenCodeModel(dork.modelChoices, model) : validModelChoice(choicesFor(app, dork), model, effort, fast);
    if (next.model === dork.model && next.effort === dork.effort && next.fast === dork.fast) return;
    patchDork(app, dorkId, { model: next.model, effort: next.effort, fast: next.fast, agentModel: undefined, agentEffort: undefined });
    if (isAwake(dork.state)) {
      // A pending configure may already have been fetched with the previous choice: replace it, so the bridge (which dedupes by
      // command id) fetches the configuration again. An ack for the dropped row is ignored.
      app.db.run("DELETE FROM commands WHERE dork_id = ? AND kind = 'configure' AND acked = 0", dorkId);
      enqueueConfigure(app, dorkId);
    }
  });
}
