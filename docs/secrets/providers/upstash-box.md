# Upstash Box (the per-dork sandbox)

Provides: `UPSTASH_BOX_API_KEY` (`shared`, secret) and `BASE_SNAPSHOT_ID` (`shared`, prod). The real Box provider is implemented in `apps/convex/convex/lib/upstash.ts` and used whenever `BOX_PROVIDER` is not `sim`. Building the base snapshot and picking optional settings are documented in [docs/upstash-box.md](../../upstash-box.md); use that for the snapshot steps and the steps below for where to store the values.

Official docs (checked 2026-10-07): [Box quickstart](https://upstash.com/docs/box/overall/quickstart), [Snapshots](https://upstash.com/docs/box/overall/snapshots).

## Dev vs prod

Dev uses `BOX_PROVIDER=sim` (in-memory box, `BASE_SNAPSHOT_ID=sim-snapshot`), so no Upstash account is needed. Prod needs a real key. If you want real boxes in dev later, create a second key named `dorks-dev` in the same console.

## Steps

1. Sign in to the Upstash Console (https://console.upstash.com) and create a **Box API key** (the docs say "create a Box API key" in the console without naming the menu; look under Box). Keys start with `box_`; the SDK reads it from `UPSTASH_BOX_API_KEY`.
2. Build the base box image (tools, `dorks-bridge`), then take a snapshot of it: call `snapshot()` on the running/paused box; the returned object has the **snapshot ID**. Snapshots outlive their box. Restores need `initCommand` passed again (it is not inherited), which `apps/convex/convex/boxes.ts` already does.
3. Insert:
   In the Doppler dashboard, `dorks` -> `prd`: set `UPSTASH_BOX_API_KEY` and `BASE_SNAPSHOT_ID`.
4. Keep `BOX_PROVIDER=upstash` in prod (already provisioned).

Unverified: the exact console menu for the key, and any plan limits; Upstash's pages do not state them.
