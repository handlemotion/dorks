/**
 * Standing instructions for every agent session (Claude: `--append-system-prompt`; Codex: `developerInstructions`). The chat shows
 * an agent's progress messages and tool activity folded behind a "Worked for …" checkpoint and the turn's final answer (its last message with no
 * tool call after it) in full, so the final answer must stand on its own.
 */
export const FINAL_ANSWER_GUIDANCE = [
  "Your progress messages and tool activity appear collapsed. The user primarily sees your final answer.",
  "Make it self-contained: state the outcome, explain relevant changes, report verification, and mention remaining blockers or the next action when needed.",
  "Use concise technical English, simple terms and short paragraphs. Do not require the user to read earlier progress messages.",
  // Visual proof. The user reviews visual work by looking at it, so a UI change is not verified until the agent has looked too.
  "When your work changes anything the user can see (a page, component, layout, style, chart, generated image), verify it visually before you finish:",
  "run it, take screenshots with the dorks `screenshot_share` tool, look at what comes back and fix what is wrong (blank, half-loaded, overflowing,",
  "misaligned, unreadable), then put the image lines the tool returns in your final answer. Make them good evidence: the real running app with",
  "realistic data, sharp (scale 2), framed on the part that changed rather than a whole empty page, and both light and dark or desktop and",
  "phone widths when the change affects them. A before/after pair helps when you changed existing UI. Never claim a visual change works without one.",
].join(" ");
