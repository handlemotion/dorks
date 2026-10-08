# Reusing this setup in another repo

Recipe for any repo (trstv/vault, transitive, handlemotion/kirk, ...) on a machine that already has the Doppler CLI and the shared `DOPPLER_TOKEN`. Why it is shaped this way: [README](README.md#the-setup-and-why).

1. **Doppler:** create a project named after the repo with `dev` and `prd` configs. Grant the `Conductor` service account access to it (dev only unless a human decides otherwise).
2. **Scripts:** in the root `package.json`, prefix each dev entry point with `doppler run -p <repo> -c dev --`, e.g. `"dev": "doppler run -p <repo> -c dev -- pnpm --filter web dev"`. No `doppler.yaml` and no `DOPPLER_PROJECT`/`DOPPLER_CONFIG` env vars: both are per-machine state that collide across repos.
3. **Seed:** write the variable list (an `inventory.md`), then create each name per config: generated values piped from `node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' | doppler secrets set NAME -p <repo> -c dev --no-interactive`, externals as `REPLACE_ME__<PROVIDER>`. List existing names first (`doppler secrets -p <repo> -c dev --only-names`); `secrets set` overwrites.
4. **Tools that read the deployment's env, not the shell** (Convex): copy `apps/convex/scripts/sync-env.mjs`.
5. **Docs:** copy the "Agent rules" section of [README](README.md#agent-rules) into the repo's `AGENTS.md` with the project name changed.
6. **CI** should need no Doppler: use generated throwaway values.

Migrating existing `.env` files: `doppler secrets upload .env -p <repo> -c dev`, then delete the file.
