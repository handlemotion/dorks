# Reusing this setup in another repo

Same recipe for any repo (trstv/vault, transitive, handlemotion/kirk, ...). Each repo gets its **own** keypair, so one leaked key exposes one repo.

1. `pnpm add -Dw @dotenvx/dotenvx` (or `npm i -D @dotenvx/dotenvx`).
2. Copy `scripts/set-secret.sh` (optional convenience for silent prompts). Run apps with plain `dotenvx run --strict -f secrets/.env.<repo>_dev -- <cmd>` from the repo root in root package.json scripts.
3. **Name the files after the repo**: `secrets/.env.<repo>_dev` and `secrets/.env.<repo>_prod` (underscore, not hyphen; dorks uses `.env.dorks_dev`). dotenvx derives the key variable from the file name, so the keys become `DOTENV_PRIVATE_KEY_<REPO>_DEV` / `_PROD` and never collide across repos on one machine. `.gitignore`: `.env*`, `!.env.example`, `!secrets/.env.<repo>_dev`, `!secrets/.env.<repo>_prod`.
4. Write a `seed-secrets.sh` table (name, kind, dev/prod value) and run it once. Keep an `inventory.md` and provider guides next to it.
5. Dev key: add `DOTENV_PRIVATE_KEY_<REPO>_DEV` to that repo's Conductor env. Prod key: `dx login`, put it in a scratch `.env.keys`, `dx armor up -f secrets/.env.<repo>_prod` (moves it to Armor and deletes the local copy; file untouched), then verify with `dx run --strict -f secrets/.env.<repo>_prod -- node -e 'console.log("ok")'`. Never put the prod key in Conductor. (`alias dx="npx -y @dotenvx/dotenvx"`.)
6. Always run via `dotenvx run --strict`: without `--strict` a missing key injects ciphertext and exits 0.

Migrating existing `.env` files: `dotenvx encrypt -f .env.production` (encrypts in place, writes the key to `.env.keys`). Existing Infisical projects can be exported once with `infisical export --env=<env> --format=dotenv` into a file you then encrypt and delete; never commit the plaintext.
