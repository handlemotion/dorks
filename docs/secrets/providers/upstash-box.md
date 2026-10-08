# Upstash Box (the per-dork sandbox)

Provides: `UPSTASH_BOX_API_KEY` (`shared`, secret) and `BASE_SNAPSHOT_ID` (`shared`, prod). The real Box provider is **not implemented yet** (`apps/api/src/lib/box.ts` `unconfiguredBox`; the Convex `getBox` falls back to it unless `BOX_PROVIDER=sim`), so these are placeholders for that work.

Official docs (checked 2026-10-07): [Box quickstart](https://upstash.com/docs/box/overall/quickstart), [Snapshots](https://upstash.com/docs/box/overall/snapshots).

## Dev vs prod

Dev uses `BOX_PROVIDER=sim` (in-memory box, `BASE_SNAPSHOT_ID=sim-snapshot`), so no Upstash account is needed. Prod needs a real key. If you want real boxes in dev later, create a second key named `dorks-dev` in the same console.

## Steps

1. Sign in to the Upstash Console (https://console.upstash.com) and create a **Box API key** (the docs say "create a Box API key" in the console without naming the menu; look under Box). Keys start with `box_`; the SDK reads it from `UPSTASH_BOX_API_KEY`.
2. Build the base box image (tools, `dorks-bridge`), then take a snapshot of it: call `snapshot()` on the running/paused box; the returned object has the **snapshot ID**. Snapshots outlive their box. Restores need `initCommand` passed again (it is not inherited), which `apps/convex/convex/boxes.ts` already does.
3. Insert:
   ```sh
   scripts/set-secret.sh prod UPSTASH_BOX_API_KEY
   printf %s "<snapshot id>" | scripts/set-secret.sh prod BASE_SNAPSHOT_ID
   ```
4. Keep `BOX_PROVIDER=upstash` in prod (already provisioned).

Unverified: the exact console menu for the key, and any plan limits; Upstash's pages do not state them.
