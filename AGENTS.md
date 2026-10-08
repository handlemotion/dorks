# Agent ground rules

## Branching

- Branch from and target `main` by default.
- Only continue on, or branch from, another feature branch when the work truly stacks on unmerged changes (it cannot work without them). If unsure, use `main`.

## Models

- Flagship models: Opus, Sonnet 5.5, Haiku 5.5. Use only these when spawning agents/sessions or choosing a model.
- Haiku 5.5 is not yet available in Conductor (expected soon); until it is, use Sonnet 5.5 in its place.
- Do not use older or non-Anthropic models (e.g. codex/gpt, cursor/grok, older Opus/Sonnet/Haiku versions).

## Secrets

Encrypted with dotenvx in git: `secrets/.env.dorks_dev` and `secrets/.env.dorks_prod`. Every variable, its owner, source and status is in `docs/secrets/inventory.md`; how to get real values is in `docs/secrets/providers/`; the full model is in `docs/secrets/README.md`.

- **Never print, log, echo, commit or ask for secret values.** No `dotenvx get/decrypt`, `printenv`, or `cat` on secrets or `.env.keys`. Never commit `.env.keys` or a plaintext value. Ask the human to paste secrets into the file themselves.
- **Dev:** `DOTENV_PRIVATE_KEY_DORKS_DEV` is in your env, so dev secrets decrypt automatically. Run apps from the repo root with `pnpm dev`, `pnpm dev:web`, etc., or `pnpm exec dotenvx run --strict -f secrets/.env.dorks_dev -- <cmd>`. Always keep `--strict` (without it a missing key injects ciphertext and exits 0).
- **Prod:** you do not have the prod key and must not try to get it (it is in Armor, human-only). You can still add or overwrite prod values (the public key is in the file) but never read them; humans review every `.env.dorks_prod` diff.
- **Change a value:** `scripts/set-secret.sh <dev|prod> NAME` (silent prompt or piped stdin), or `NAME --generate b64|hex` for a random value that is never printed. Then check `git diff secrets/` shows only the intended names, and commit the encrypted file.
- **New env var in code:** read it by its exact name, then add a row to `docs/secrets/inventory.md`, the name to the unit's `.env.example`, and a row to `scripts/seed-secrets.sh` (idempotent; never overwrites existing values). Use `REPLACE_ME__<PROVIDER>` for values only a human can obtain.
- Public build-time values (`VITE_*`, `EXPO_PUBLIC_*`) ship to clients: never put a real secret behind those prefixes.
