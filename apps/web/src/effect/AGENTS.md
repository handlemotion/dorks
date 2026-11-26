# Effect UI code

Everything under this folder is Effect UI (`@effect/ui`, `@effect/ui-kit`), not React. Before writing any of it, read
`node_modules/@effect/ui/AGENTS.md` (the official guide for the installed build) and `docs/effect-ui-migration.md` (how islands mount
into the React app, the conventions and the plan). Typecheck with `pnpm --filter @dorks/web typecheck`, which also checks this folder
with `exactOptionalPropertyTypes`.
