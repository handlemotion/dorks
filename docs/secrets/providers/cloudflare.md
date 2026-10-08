# Cloudflare (Workers deploys for web and the legacy api)

Provides: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (`shared`, **prod only**). Used by `wrangler deploy` for `apps/web` (`dorks-web`) and the legacy `apps/api` (`dorks-api`). There is no CI yet; today a person deploys with `wrangler login`. These are only needed once deploys move to CI. Local dev does not need them.

Official docs (checked 2026-10-07): [Workers CI/CD with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

## Steps

1. Cloudflare dashboard -> **Manage Account -> Account API tokens** -> **Create Token** (an _account_ token, so it outlives any person).
2. Under **Permission policies**, choose the **Edit Cloudflare Workers** template/permission. Restrict **Account Resources** to the single dorks account. (The api also uses D1 and Durable Objects: add **D1: Edit** if migrations are deployed by CI.) Copy the token; it is shown once.
3. Account ID: dashboard -> **Workers & Pages** overview (right side), or **Find account and zone IDs** in Cloudflare docs.
4. Insert:
   ```sh
   scripts/set-secret.sh prod CLOUDFLARE_API_TOKEN
   printf %s "<account id>" | scripts/set-secret.sh prod CLOUDFLARE_ACCOUNT_ID
   ```
5. In CI, store the prod dotenvx key (`DOTENV_PRIVATE_KEY_PROD`) as a CI secret and run `DORKS_ENV=prod scripts/with-secrets.sh web -- wrangler deploy`.

Unverified: the exact menu labels in the current Cloudflare dashboard vary (docs show both account-level and profile-level token pages); follow whichever your dashboard shows.
