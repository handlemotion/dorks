// The agents' and GitHub's logos, light and dark where svgl ships both. `?url` so Vite (apps/web) and Astro (apps/site) both import
// them as plain URLs.
import antigravity from "./assets/providers/antigravity.svg?url";
import claude from "./assets/providers/claude.svg?url";
import codexDark from "./assets/providers/codex_dark.svg?url";
import codexLight from "./assets/providers/codex_light.svg?url";
import githubDark from "./assets/providers/github-dark.svg?url";
import githubLight from "./assets/providers/github-light.svg?url";
import grokDark from "./assets/providers/grok-dark.svg?url";
import grokLight from "./assets/providers/grok-light.svg?url";
import openaiDark from "./assets/providers/openai-dark.svg?url";
import openaiLight from "./assets/providers/openai-light.svg?url";
import opencodeDark from "./assets/providers/opencode-dark.svg?url";
import opencodeLight from "./assets/providers/opencode.svg?url";

export const LOGOS = {
  antigravity: { light: antigravity },
  claude: { light: claude },
  codex: { light: codexLight, dark: codexDark },
  github: { light: githubLight, dark: githubDark },
  grok: { light: grokLight, dark: grokDark },
  openai: { light: openaiLight, dark: openaiDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
} satisfies Record<string, { light: string; dark?: string }>;
