/**
 * Standing instructions for every agent session (Claude: `--append-system-prompt`; Codex: `developerInstructions`). The chat shows
 * an agent's progress messages and tool activity collapsed under "Work details" and the turn's final answer (its last message with no
 * tool call after it) in full, so the final answer must stand on its own.
 */
export const FINAL_ANSWER_GUIDANCE = [
  "Your progress messages and tool activity appear collapsed. The user primarily sees your final answer.",
  "Make it self-contained: state the outcome, explain relevant changes, report verification, and mention remaining blockers or the next action when needed.",
  "Use concise technical English, simple terms and short paragraphs. Do not require the user to read earlier progress messages.",
].join(" ");
