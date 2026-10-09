---
name: cloud-bootstrap
description: Add or update the standard one-script setup (`cloud-setup.sh`) that takes a bare cloud agent VM to a working checkout. Use when setting up a repo for cloud agents (Claude Code on the web, Codex, Cursor, Jules, Devin, Copilot, dev containers), when `pnpm install` or tests fail on a fresh VM, or when a new product needs the same setup as dorks.
---

# cloud-bootstrap: one setup script for every cloud provider

## Why this exists

A cloud agent VM starts from a bare image. In it, a modern JS repo usually cannot install on its own:

1. **The pinned package manager does not run.** The image's older corepack cannot run newer pnpm (pnpm 12 ships `bin/pnpm.mjs`, corepack 0.34 looks for `pnpm.cjs`), so `pnpm` crashes with `MODULE_NOT_FOUND`.
2. **The secrets CLI is missing.** Secrets live in Doppler, and the VM has no Doppler CLI.
3. **The install needs a secret.** dorks' install runs a license check (`CENTRAL_LICENSE_KEY`) that only exists in Doppler, so `pnpm install` fails without it.

Without a fix the agent boots into a repo it cannot build or test, and every provider and every product ends up with its own copy-pasted, drifting setup steps. The standard is: **one idempotent script at the repo root, `cloud-setup.sh`, that every provider calls.** Provider configs hold only the one-line command and one secret, never setup logic.

## The contract

- Lives at the repo root as `cloud-setup.sh`. Runs from any directory (it `cd`s to its own location).
- Idempotent and non-interactive. Works as root or an unprivileged user (uses `sudo -n` only if present, else installs tools under `~/.local`).
- Exits non-zero if a required step fails, so a provider's setup log shows it.
- Installs: the secrets CLI, the package manager at the version the repo pins, then dependencies, run under the secrets config so install-time secrets resolve.
- Optional heavy steps (a local backend, Docker images) sit behind a flag (`--full`/`--backend`), never in the default path, because it runs at every session start.
- Needs exactly one thing from the provider: `DOPPLER_TOKEN` in the environment.

## Add it to a product

1. Copy `cloud-setup.template.sh` (next to this file) to the repo root as `cloud-setup.sh` and `chmod +x` it.
2. Edit only the config block at the top: `NODE_MIN`, `SECRETS_PROJECT` (the Doppler project), `SECRETS_CONFIG` (`dev`, never production), `EXTRA_NPM_TOOLS`, `FULL_SETUP_CMD`.
3. Make sure `package.json` has a `packageManager` field (pnpm) so the version is pinned.
4. Add a "Cloud setup" section to the repo's `AGENTS.md` saying why the script exists and the two provider settings below (dorks' `AGENTS.md` is the model).
5. For Claude Code on the web, also add a SessionStart hook in `.claude/settings.json` running `bash "$CLAUDE_PROJECT_DIR/cloud-setup.sh"`.
6. Tell a human to set, on each cloud provider:
   - **Setup / install command:** `bash cloud-setup.sh` (from the repo root). If the provider runs it before the repo exists, use a small wrapper that looks for the file and falls back to the SessionStart hook.
   - **Secret / env var:** `DOPPLER_TOKEN`.

Do not add per-provider config files (devcontainer, Cursor, Conductor, Copilot workflows) unless the team actually uses that provider; if added, they only call the script.

## Verify before declaring it done

Run each as the situations apply and read the output; a pass is the script exiting 0 with dependencies installed.

- In place, twice (idempotent).
- With the package manager's shim broken or absent (the corepack case).
- With the secrets CLI removed from the machine (the installer path).
- As an unprivileged user with `DOPPLER_TOKEN` (root-only assumptions show up here).
- With `--full`/`--backend` if the flag is configured.

dorks' own `cloud-setup.sh` was validated on all of these except a machine with no Node, a non-Debian OS, and any provider other than Claude Code on the web.

## Gotchas learned

- Do not rely on corepack on cloud images; verify `pnpm --version` equals the pinned version and fall back to `npm i -g pnpm@<pinned>`.
- A root-owned global npm prefix and passwordless-sudo-less users are common; the `~/.local` fallback is what makes the non-root case work.
- The secrets-manager install step must be skippable (`SECRETS_PROJECT` empty) for repos that do not use one.
- Claude Code refuses `--permission-mode bypassPermissions` as root, so running the real agent on a root-only VM needs an unprivileged user (see dorks' README, "Running the real agent locally").
- Keep the script free of repo-specific logic beyond the config block; changes to what "setup" means go in the script, not in provider configs.
