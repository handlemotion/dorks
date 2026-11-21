// Contrast ratios (WCAG relative luminance) between the surfaces the Liquid Glass layer stacks, so a border or shadow is only
// added where fill alone fails. Colors are OKLCH [L, C, h] (alpha composited over what is below); edit the numbers when glass.css changes.
//
//   node packages/ui/scripts/contrast.mjs
//
// Rule of thumb used in packages/ui/README.md: two adjacent fills separate on their own at >= 1.15:1. Below that, change the fill (never a drop
// shadow, and only as a last resort a hairline). Form controls keep their border regardless: WCAG 1.4.11 asks 3:1 for their boundary.

const clamp = (x) => Math.min(1, Math.max(0, x))
function oklchToLinear([L, C, h]) {
  const a = C * Math.cos((h * Math.PI) / 180)
  const b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(clamp)
}
const over = (top, alpha, below) => top.map((c, i) => c * alpha + below[i] * (1 - alpha))
const lum = ([r, g, b]) => {
  const f = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
  const lin = (c) => {
    const s = f(c)
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
// The luminance above takes sRGB-encoded channels; the matrices above give linear light, so convert directly instead.
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const ratio = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}
void lum

const themes = {
  light: {
    // vibrancy material is unknown; the tint over it is what the app controls. Worst case: a mid-gray material under the tint.
    backdrop: over(oklchToLinear([1, 0, 0]), 0.3, oklchToLinear([0.8, 0, 0])),
    sidebar: (below) => over(oklchToLinear([1, 0, 0]), 0.58, below),
    content: (below) => over(oklchToLinear([0.935, 0.004, 260]), 0.85, below),
    bubble: oklchToLinear([1, 0, 0]),
    card: () => oklchToLinear([1, 0, 0]),
    input: (below) => over(oklchToLinear([0.922, 0, 0]), 0.3, below),
    text: oklchToLinear([0.145, 0, 0]),
  },
  dark: {
    backdrop: over(oklchToLinear([0.18, 0, 0]), 0.55, oklchToLinear([0.35, 0, 0])),
    sidebar: (below) => over(oklchToLinear([0.42, 0, 0]), 0.52, below),
    content: (below) => over(oklchToLinear([0.2, 0, 0]), 0.82, below),
    bubble: oklchToLinear([1, 0, 0]),
    // Settings cards in dark: foreground at 6% over the panel (`dark:bg-foreground/[0.06]`), not the opaque --card.
    card: (below) => over(oklchToLinear([0.985, 0, 0]), 0.06, below),
    input: (below) => over(oklchToLinear([1, 0, 0]), 0.15, below),
    text: oklchToLinear([0.985, 0, 0]),
  },
}

for (const [name, t] of Object.entries(themes)) {
  const content = t.content(t.backdrop)
  const sidebar = t.sidebar(t.backdrop)
  const rows = [
    ["content panel vs backdrop", ratio(content, t.backdrop)],
    ["sidebar glass vs backdrop", ratio(sidebar, t.backdrop)],
    ["user bubble vs content panel", ratio(t.bubble, content)],
    ["card vs content panel", ratio(t.card(content), content)],
    ["input fill vs card", ratio(t.input(t.card(content)), t.card(content))],
    ["body text vs content panel", ratio(t.text, content)],
  ]
  console.log(`\n${name}`)
  for (const [label, r] of rows) console.log(`  ${r.toFixed(2).padStart(5)}:1  ${label}${r >= 1.15 ? "" : "   (< 1.15: needs a hairline)"}`)
}

// The flat app (glass.css today): one opaque fill, --app, and --surface raised on it. The rows above model the old glass layers.
const flat = {
  light: { app: oklchToLinear([0.9612, 0, 0]) /* #f2f2f2 */, surface: oklchToLinear([1, 0, 0]) },
  dark: { app: oklchToLinear([0.165, 0, 0]), surface: oklchToLinear([0.24, 0, 0]) },
}
for (const [name, t] of Object.entries(flat)) {
  const r = ratio(t.surface, t.app)
  console.log(`\nflat ${name}\n  ${r.toFixed(2).padStart(5)}:1  surface vs app${r >= 1.15 ? "" : "   (< 1.15: needs a hairline, --surface-line)"}`)
}
