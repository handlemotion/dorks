# Cloudflare (Workers deploy for web)

Provides: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (`shared`, **prod only**). Used by `wrangler deploy` for `apps/web` (`dorks-web`). There is no CI yet; today a person deploys with `wrangler login`. These are only needed once deploys move to CI. Local dev does not need them.

Official docs (checked 2026-10-07): [Workers CI/CD with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

## Steps

1. Cloudflare dashboard -> **Manage Account -> Account API tokens** -> **Create Token** (an _account_ token, so it outlives any person).
2. Under **Permission policies**, choose the **Edit Cloudflare Workers** template/permission. Restrict **Account Resources** to the single dorks account. Copy the token; it is shown once.
3. Account ID: dashboard -> **Workers & Pages** overview (right side), or **Find account and zone IDs** in Cloudflare docs.
4. Insert:
   ```sh
   scripts/set-secret.sh prod CLOUDFLARE_API_TOKEN
   printf %s "<account id>" | scripts/set-secret.sh prod CLOUDFLARE_ACCOUNT_ID
   ```
5. In CI, store the prod dotenvx key (`DOTENV_PRIVATE_KEY_DORKS_PROD`) as a CI secret and run `pnpm exec dotenvx run --strict -f secrets/.env.dorks_prod -- wrangler deploy` from the repo root.

Unverified: the exact menu labels in the current Cloudflare dashboard vary (docs show both account-level and profile-level token pages); follow whichever your dashboard shows.
