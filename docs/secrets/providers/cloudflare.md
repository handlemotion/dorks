# Cloudflare (Workers deploys for web and the legacy api)

Provides: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (`shared`, **prod only**). Used by `wrangler deploy` for `apps/web` (`dorks-web`) and the legacy `apps/api` (`dorks-api`). There is no CI yet; today a person deploys with `wrangler login`. These are only needed once deploys move to CI. Local dev does not need them.

Official docs (checked 2026-10-07): [Workers CI/CD with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

## Steps

1. Cloudflare dashboard -> **Manage Account -> Account API tokens** -> **Create Token** (an _account_ token, so it outlives any person).
2. Under **Permission policies**, choose the **Edit Cloudflare Workers** template/permission. Restrict **Account Resources** to the single dorks account. (The api also uses D1 and Durable Objects: add **D1: Edit** if migrations are deployed by CI.) Copy the token; it is shown once.
3. Account ID: dashboard -> **Workers & Pages** overview (right side), or **Find account and zone IDs** in Cloudflare docs.
4. Insert:
   In the Doppler dashboard, `dorks` -> `prd`: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Deploy: `doppler run -p dorks -c prd -- wrangler deploy` from the app folder (humans only; the `prd` config is not for agents). For CI, give it a Doppler service token scoped to `prd` as the one CI secret (`DOPPLER_TOKEN`).

## Pushing runtime secrets to the Workers

Doppler has no managed Cloudflare Workers sync for this setup; its documented path is the CLI. Only `apps/api` (legacy) declares required secrets (`secrets.required` in its `wrangler.jsonc`); `apps/web` has none. From `apps/api`, a human runs:

```sh
doppler secrets download -p dorks -c prd --no-file --format json \
  | jq '{BETTER_AUTH_SECRET, ENCRYPTION_KEY, UPSTASH_BOX_API_KEY, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, RESEND_API_KEY, EXPO_ACCESS_TOKEN}' \
  | wrangler secret bulk
```

The `jq` filter is the `secrets.required` list. Values only travel through the pipe. Unverified: not run against a real Worker (no Cloudflare credentials yet); `wrangler secret bulk` reading JSON from stdin is documented by Cloudflare.

Unverified: the exact menu labels in the current Cloudflare dashboard vary (docs show both account-level and profile-level token pages); follow whichever your dashboard shows.
