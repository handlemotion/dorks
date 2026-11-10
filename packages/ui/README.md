# @dorks/ui

shadcn/ui components (Base UI primitives) plus the shadcn **AI Elements** patterns, themed by one shadcn preset and a small Liquid Glass layer.
Components are third-party source kept as published: change tokens in `src/styles.css` and `src/glass.css`, not the component files.

## Preset

| | |
|---|---|
| Preset code | `b1VlItxS` |
| Open in shadcn/create | https://ui.shadcn.com/create?preset=b1VlItxS |
| Style | `luma` (`base-luma` in `components.json`: soft, very round, light shadows) |
| Base color / theme | `neutral` |
| Icons | `lucide` |
| Font | Geist and Geist Mono (`@fontsource-variable/geist`, set in `src/styles.css`; the preset ships Inter) |
| Radius | `large` (`--radius: 0.875rem`) |
| Menus | `default-translucent`, accent `subtle` |

Open the link to tweak it visually, then:

```sh
pnpm dlx shadcn@latest preset decode <code>               # what a code contains
pnpm dlx shadcn@latest preset resolve --cwd packages/ui   # which preset this project resolves to
```

`shadcn apply` and `shadcn init` need a framework they can detect, and this is a library. To move to a new preset: generate it in a scratch
Vite project (`pnpm dlx shadcn@latest init -t vite -p <code> --base base --no-monorepo -y`), copy its `:root`/`.dark`/`@theme inline` blocks into
`src/styles.css` (keep the `@import "./glass.css"` line), set `style` in `components.json` to `base-<style>`, then re-add the components from this
folder with `pnpm dlx shadcn@latest add <names> -y -o`. Do not run `shadcn init` here: it would overwrite `components.json` and the tokens.

## Design rules

UI rules: **no drop shadows, minimal borders, an opaque flat app, white user bubbles, 6px controls.** They are written down because they are easy to break
by accident, and `pnpm test` enforces the first one.

1. **No drop shadows, ever.** Not in any theme, and not on cards, popovers, menus, dialogs or bubbles. `src/glass.css` resets Tailwind's
   `--shadow-*`, `--inset-shadow-*`, `--drop-shadow-*` and `--text-shadow-*` theme namespaces, so a `shadow-*` class in the published shadcn and
   AI Elements files generates no CSS and those files stay unmodified. Glass has no inner highlight either. Focus rings stay (a ring on a
   focused control is not a shadow). `node packages/ui/scripts/check-ui-rules.mjs` (run by `pnpm test`) fails on `shadow-*`, `box-shadow`,
   `drop-shadow` and `text-shadow` in `apps/web/src`, `packages/ui/src/*.css` and our own files in `packages/ui/src`; the only allowed lines
   carry `ui-rules: allow` (the theme reset itself).
2. **Minimal borders.** Separate surfaces with fill, spacing and glass layering. The default border colour (`--border`) is nearly transparent, the
   published components' 1px `ring-1` outlines on cards, popovers, menus and dialogs are switched off in the theme, and glass has no border. A
   border is allowed only where fill contrast truly fails: form controls keep `--input` (light-theme input fill vs card is 1.07:1, and WCAG 1.4.11
   asks 3:1 for a control's boundary) and focus rings. Measure rather than guess: `node packages/ui/scripts/contrast.mjs` prints the contrast
   between the stacked surfaces; at or above **1.15:1** fill alone is enough, below that change the fill first.
3. **The app is opaque and flat, and follows the app theme.** One fill, `--app` (`#f2f2f2` in light), behind everything, and `--surface` (white
   in light) for the few raised things on it. Nothing is translucent or blurred, including dialog overlays, and the desktop app's native material
   never shows through (the page paints `--app` over it). The `glass*` utilities still exist as names but are solid `--surface` fills. White on
   `#f2f2f2` is 1.12:1, under 1.15, so a raised surface carries the `--surface-line` hairline (`#e2e2e2`) in light; dark separates on fill.
   When you add a surface, give it a light and a dark value.
4. **User message bubbles are white** (`--user-bubble`), in light and dark, so they pop against the app. Assistant messages are unbubbled text.
5. **Everything is 6px.** Controls, menus, dialogs, message bubbles, sidebar rows, cards and Chat details all use `--control-radius` (6px,
   `src/glass.css`): the whole `rounded-sm` to `rounded-4xl` scale maps to it (`src/styles.css`), and controls also get it by `data-slot`, so
   the component files stay unmodified. The one exception is onboarding's step buttons, which are pills: they set
   `--control-radius: var(--radius-pill)` on themselves.
   Focus on a control is its border turning the brand blue (`--ring`), with no glow around it. Dialogs and toasts are styled the same way
   (white sheet with an `--app` footer band; brand-blue toasts).
6. **Nothing heavier than medium (500), and two text sizes.** `text-sm` for content, `text-xs` for secondary text (a focused page's one title: an onboarding step, the connect screen,
   the new-session page, is `text-lg`). The heavier weights are mapped to 500 in `src/glass.css`, and `pnpm test` fails on `font-semibold` or
   heavier in app code.

| Pair (from `contrast.mjs`) | Light | Dark |
|---|---|---|
| surface vs app (the `flat` rows) | 1.12 (hairline) | 1.17 |

## What is in here

- `src/styles.css`: the preset's CSS variables (`:root`, `.dark`, `@theme inline`) plus `@import "./glass.css"`.
- `src/glass.css`: the shadow reset, Liquid Glass tokens and utilities (`glass`, `glass-strong`, `glass-content`, `app-backdrop`), the white user-bubble
  tokens, the near-transparent border colour and the reduced-transparency fallback. Ours, not part of the preset.
- `scripts/check-ui-rules.mjs` and `scripts/contrast.mjs`: the no-shadows check (run by `pnpm test`) and the contrast numbers.
- `src/components/ui/*`: registry components installed with the shadcn CLI (run in this directory), including the building blocks AI Elements
  are made of (`trace`, `message`, `bubble`, `message-scroller`, `code-block`, `input-group`, `attachment`, `marker`, `questionnaire`, ...) and the app
  components (`sidebar`, `sheet`, `dialog`, `tabs`, `select`, `switch`, `field`, `sonner`, `card`, `alert`, ...).
- `src/components/ai-elements/*`: the 21 AI Elements patterns from https://ui.shadcn.com/docs/ai-elements (Base variant): chain-of-thought, chat,
  checkpoint, confirmation, context, file-tree, inline-citation, message, model-selector, plan, prompt-input, queue, reasoning, sources, stack-trace,
  subagent, suggestion, task, terminal, test-results, tool. Import as `@dorks/ui/ai-elements/<name>`.
- `src/components/markdown.tsx`, `src/lib/ai.ts`, `src/lib/message-animations.ts`: helper files the patterns import. They are docs-site files of the
  shadcn repo (not in the registry), copied as they are.

AI Elements are **patterns, not packages**: each docs page is a composition of the registry components that you copy into your app. Each file in
`ai-elements/` is the page's example (`XDemo`), complete and unmodified, so use it as the source to lift from. They run offline: the conversations are
scripted with `createChat` from `@shadcn/helpers/ai-sdk`. The old Vercel "AI SDK Elements" (`elements.ai-sdk.dev`) are not used.

## What was cloned

| | |
|---|---|
| Docs | https://ui.shadcn.com/docs/ai-elements (Base), fetched 2026-11-09 |
| Helper files from | `shadcn-ui/ui` commit `8ab27715521cbd4f87ae6886cd989cbb678f6de7` (2026-11-08), `apps/v4/{components/markdown.tsx,lib/ai.ts,lib/message-animations.ts}` |
| Registry style | `base-luma` for the stock components (re-added over the first `base-rhea` install), shadcn CLI 4.23.0 |

The only edit to the pattern files is the import paths, as the docs ask: `@/components/ui/x` becomes `#ui/x`, `@/components/markdown` becomes
`#markdown`, `@/lib/*` becomes `#lib/*`, and two imports inside `markdown.tsx` are mapped to `#hooks/*` and `#ui/*` (see `imports` in `package.json`).
The CLI itself rewrote `@/lib/utils` to the `cn` package. `noUnusedLocals` is off here and in `apps/web`, because some published files import `React`
without using it.

## Updating

```sh
# registry components (overwrites; review the diff)
pnpm dlx shadcn@latest add trace message bubble code-block message-scroller input-group attachment marker questionnaire -y --overwrite
# patterns and helper files; the argument is a shadcn-ui/ui commit or branch for the helper files
node scripts/update-ai-elements.mjs [ref]
```

Then update the tables above, run `pnpm typecheck` at the repo root, and open `/dev/ai-elements` (dev builds only) to see every pattern.

Consume with `import { Button } from '@dorks/ui/button'`. An app imports `@dorks/ui/styles.css` after `@import "tailwindcss"` and adds
`@source "../../../packages/ui/src"`.
