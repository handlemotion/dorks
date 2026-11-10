# @dorks/ui

shadcn/ui components (style `base-rhea`, Base UI primitives, see `components.json`) plus the shadcn **AI Elements** patterns. Everything here is third-party source kept as published: change tokens in `src/styles.css`, not the component files.

## What is in here

- `src/components/ui/*`: the registry components, installed with the shadcn CLI (`npx shadcn@latest add <name>` run in this directory). Includes the building blocks AI Elements are made of: `trace`, `message`, `bubble`, `message-scroller`, `code-block`, `input-group`, `attachment`, `marker`, `questionnaire`, `collapsible`, `hover-card`, `item`, `badge`, `sheet`, `progress`, `empty`, `tooltip`, `scroll-area`, `dropdown-menu`, `button`, `input`, `textarea`.
- `src/components/ai-elements/*`: the 21 AI Elements patterns from https://ui.shadcn.com/docs/ai-elements (Base variant): chain-of-thought, chat, checkpoint, confirmation, context, file-tree, inline-citation, message, model-selector, plan, prompt-input, queue, reasoning, sources, stack-trace, subagent, suggestion, task, terminal, test-results, tool. Import as `@dorks/ui/ai-elements/<name>`.
- `src/components/markdown.tsx`, `src/lib/ai.ts`, `src/lib/message-animations.ts`: helper files the patterns import. They are docs-site files of the shadcn repo (not in the registry), copied as they are.

shadcn's AI Elements are **patterns, not packages**: each docs page is a composition of the registry components above that you copy into your app. Each file in `ai-elements/` is the page's example (`XDemo`), complete and unmodified, so use it as the source to lift from. They run offline: the conversations are scripted with `createChat` from `@shadcn/helpers/ai-sdk`.

The old Vercel "AI SDK Elements" (`elements.ai-sdk.dev`) are not used. The shadcn docs list which of its parts have no replacement (for example `artifact`, which is built from Card, Button and Tooltip).

## What was cloned

| | |
|---|---|
| Docs | https://ui.shadcn.com/docs/ai-elements (Base), fetched 2026-11-09 |
| Helper files from | `shadcn-ui/ui` commit `8ab27715521cbd4f87ae6886cd989cbb678f6de7` (2026-11-08), `apps/v4/{components/markdown.tsx,lib/ai.ts,lib/message-animations.ts}` |
| Registry style | `base-rhea`, shadcn CLI 4.23.0 |

The only edit to the pattern files is the import paths, which the docs ask you to adjust ("Update the import paths to match your project setup"): `@/components/ui/x` becomes `#ui/x`, `@/components/markdown` becomes `#markdown`, `@/lib/*` becomes `#lib/*`, and two imports inside `markdown.tsx` are mapped to `#hooks/*` and `#ui/*` (see `imports` in `package.json`). The CLI itself rewrote `@/lib/utils` to the `cn` package in the registry components.

`noUnusedLocals` is off in this package and in `apps/web`, because some published files import `React` without using it.

## Updating

```sh
# registry components (overwrites; review the diff)
npx shadcn@latest add trace message bubble code-block message-scroller input-group attachment marker questionnaire -y --overwrite
# patterns and helper files; the argument is a shadcn-ui/ui commit or branch for the helper files
node scripts/update-ai-elements.mjs [ref]
```

Then update the table above, run `pnpm typecheck` at the repo root, and open `/dev/ai-elements` (`pnpm dev:web`, dev builds only) to see every pattern. Do not run `shadcn init` here: it would overwrite `components.json` and the tokens in `src/styles.css`.
