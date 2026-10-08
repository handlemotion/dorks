# Cloudflare (Workers deploy for web)

Provides: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (`shared`, **prod only**). Used by `wrangler deploy` for `apps/web` (`dorks-web`). There is no CI yet; today a person deploys with `wrangler login`. These are only needed once deploys move to CI. Local dev does not need them.

Official docs (checked 2026-10-07): [Workers CI/CD with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

## Steps

1. Cloudflare dashboard -> **Manage Account -> Account API tokens** -> **Create Token** (an _account_ token, so it outlives any person).
2. Under **Permission policies**, choose the **Edit Cloudflare Workers** template/permission. Restrict **Account Resources** to the single dorks account. Copy the token; it is shown once.
3. Account ID: dashboard -> **Workers & Pages** overview (right side), or **Find account and zone IDs** in Cloudflare docs.
4. Insert:
   In the Doppler dashboard, `dorks` -> `prd`: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Deploy: `doppler run -p dorks -c prd -- wrangler deploy` from the app folder (humans only; the `prd` config is not for agents). For CI, give it a Doppler service token scoped to `prd` as the one CI secret (`DOPPLER_TOKEN`).

## Pushing runtime secrets to a Worker

No Worker declares secrets today (`apps/web` has none; runtime secrets live on the Convex deployment). Doppler has no managed Cloudflare Workers sync; if a Worker ever needs some, its documented path is the CLI, run by a human from the Worker's folder:

```sh
doppler secrets download -p dorks -c prd --no-file --format json | jq '{NAME_A, NAME_B}' | wrangler secret bulk
```

The `jq` filter picks the names the Worker needs. Values only travel through the pipe. Unverified: not run against a real Worker (no Cloudflare credentials yet).

Unverified: the exact menu labels in the current Cloudflare dashboard vary (docs show both account-level and profile-level token pages); follow whichever your dashboard shows.
