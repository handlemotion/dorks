# Reusing this setup in another repo

Same recipe for any repo (trstv/vault, transitive, handlemotion/kirk, ...). Each repo gets its **own** keypair, so one leaked key exposes one repo.

1. `pnpm add -Dw @dotenvx/dotenvx` (or `npm i -D @dotenvx/dotenvx`).
2. Copy `scripts/with-secrets.sh` and `scripts/set-secret.sh`. Both are repo-agnostic except the `DORKS_ENV` variable name and error text (rename to `<REPO>_ENV` if you like).
3. `.gitignore`: `.env*`, `!.env.example`, `!secrets/.env.dev`, `!secrets/.env.prod`.
4. Write a `seed-secrets.sh` table (name, kind, dev/prod value) and run it once. Keep an `inventory.md` and provider guides next to it.
5. Save both private keys in the password manager; add only `DOTENV_PRIVATE_KEY_DEV` to that repo's Conductor env. Never the prod key.
6. Always run via `dotenvx run --strict`: without `--strict` a missing key injects ciphertext and exits 0.

Migrating existing `.env` files: `dotenvx encrypt -f .env.production` (encrypts in place, writes the key to `.env.keys`). Existing Infisical projects can be exported once with `infisical export --env=<env> --format=dotenv` into a file you then encrypt and delete; never commit the plaintext.
