// The effort each model starts at, kept in one place so what the composer shows is what it sends.
//
// A model starts at the effort the owner last picked for it (remembered in this browser, with no expiry), else at the one its maker
// recommends (as of November 2026):
// - Claude Opus 5.5 and Haiku 5.5: medium, Anthropic's default for them (platform.claude.com, "Effort"); every other Claude model
//   with efforts (Fable, Sonnet, older Opus): high, Anthropic's default for the rest.
// - Codex (GPT Sol and Astra): medium, where OpenAI says to start.
// - Antigravity (Gemini): medium. Neon defaults to high upstream, but medium does most work for far fewer thinking tokens.
// A recommendation the model does not offer falls to the nearest one it does.

const KEY = 'dorks.efforts.v1'
const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** What the owner picked, by `provider:model` (an Antigravity model by its family, without the effort suffix). */
function saved(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Remembers the effort the owner picked for a model, for every session after this one. */
export function rememberEffort(provider: string, model: string | undefined, effort: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), [`${provider}:${model ?? ''}`]: effort }))
  } catch {
    /* storage full or blocked: the recommendation still applies */
  }
}

/** The maker's recommendation for a model (`hint`: what an alias resolves to, such as `claude-opus-5-5` for `opus`). */
export function recommendedEffort(provider: string, model: string | undefined, hint?: string): string {
  if (provider !== 'claude') return 'medium'
  // `opus` / `claude-opus-5-5` (and a bare alias before the agent resolved it): Opus and Haiku 5.x.
  return /^(claude-)?(opus|haiku)(-5|$)/.test(hint || model || '') ? 'medium' : 'high'
}

/** The nearest effort to `want` among `efforts` (the higher one on a tie). */
function nearest(efforts: readonly string[], want: string): string | undefined {
  if (efforts.includes(want)) return want
  const at = ORDER.indexOf(want)
  return [...efforts].sort((a, b) => Math.abs(ORDER.indexOf(a) - at) - Math.abs(ORDER.indexOf(b) - at) || ORDER.indexOf(b) - ORDER.indexOf(a))[0]
}

/** The effort a model starts at: the owner's last pick for it when the model offers it, else the recommendation. None without efforts. */
export function startingEffort(provider: string, model: string | undefined, efforts: readonly string[], hint?: string): string | undefined {
  if (!efforts.length) return undefined
  const mine = saved()[`${provider}:${model ?? ''}`]
  if (mine && efforts.includes(mine)) return mine
  return nearest(efforts, recommendedEffort(provider, model, hint))
}
