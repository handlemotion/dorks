# Agent ground rules

## Branching

- Branch from and target `main` by default.
- Only continue on, or branch from, another feature branch when the work truly stacks on unmerged changes (it cannot work without them). If unsure, use `main`.

## Models

- Flagship models: Opus, Sonnet 5.5, Haiku 5.5. Use only these when spawning agents/sessions or choosing a model.
- Haiku 5.5 is not yet available in Conductor (expected soon); until it is, use Sonnet 5.5 in its place.
- Do not use older or non-Anthropic models (e.g. codex/gpt, cursor/grok, older Opus/Sonnet/Haiku versions).

## Secrets

Doppler is the source of truth (project `dorks`, configs `dev` and `prd`). `DOPPLER_TOKEN` is already in your environment, so `pnpm dev`, `pnpm dev:web`, etc. run with dev secrets and need no setup. Variable inventory: `docs/secrets/inventory.md`; full model: `docs/secrets/README.md`.

- **Never print, log, echo, read or commit secret values.** No `doppler secrets get`/`download`, `doppler run -- printenv`, or `cat .env*`. Names only: `doppler secrets -p dorks -c dev --only-names`.
- **No prod.** Never run a command with `-c prd`. Humans edit prod in the Doppler dashboard.
- **Add or change a dev secret** without echoing it: `printf %s 'value' | doppler secrets set NAME -p dorks -c dev --no-interactive` (random: pipe `node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'`). For values only a human has, set `REPLACE_ME__<PROVIDER>` and ask them to fill it in. Don't overwrite a value you didn't create.
- **New env var in code:** read it by its exact name, add a row to `docs/secrets/inventory.md` and the name to the unit's `.env.example`, create it in `dev`, and tell the human to create it in `prd`.
- `VITE_*` / `EXPO_PUBLIC_*` ship to clients: never put a real secret behind those prefixes.
