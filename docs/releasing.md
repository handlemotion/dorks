# Releasing Dorks

Dorks ships as a signed, notarized macOS app for Apple silicon, published as a GitHub release. Installed apps check for a newer release shortly after launch and every 15 minutes and offer it in the sidebar's blue update bar ([desktop.md](desktop.md#updates)). There is no Intel build for now.

Versions are kept with [Changesets](https://github.com/changesets/changesets). The version that ships is `apps/desktop/package.json`'s; the release step copies it to `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`.

## The flow

1. **A PR that changes what users get adds a changeset.** Run `pnpm changeset`, pick `@dorks/desktop`, choose the bump (`patch` for fixes, `minor` for features; no `major` before 1.0) and write one or two sentences for the release notes, in the user's words. This adds a file under `.changeset/`; commit it with the PR. Internal changes (CI, docs, refactors) need none.
2. **Merge PRs as usual.** On every push to `main`, `.github/workflows/release.yml` keeps one PR open, **Release Dorks**, that applies the pending changesets: the new version in every file above and the notes in `apps/desktop/CHANGELOG.md`. It updates itself as more PRs land. Edit the notes in that PR if you like.
3. **Merge the release PR when you want to ship.** `main` now has a version with no GitHub release, so the workflow calls `desktop-release.yml`: it builds the app, signs and notarizes it, uploads `dorks-v<version>.dmg`, the signed updater bundle (`dorks-v<version>.app.tar.gz` and its `.sig`) and `latest.json` to a draft release `desktop-v<version>` with the changelog section as its notes, and then publishes it as the latest release. That takes about 7 minutes (0.4.0: 6 min 40 s from merge to published), less once the Rust build cache is warm.
4. **New users download it** from https://dorks.build/download, which the site's edge Worker redirects to the latest release's `.dmg` (`/download/<version>` for a given one; `apps/site/src/worker.ts`). The site's buttons show its version and size.
5. **Users update.** Within 15 minutes (or on the next launch, or Check for Updates… in the menu bar) installed apps see `latest.json` and show the blue bar; Update installs it and relaunches.

## npm packages

`@dorks/core` (`packages/core`) and `@dorks/shared` (`packages/shared`) are published to npm under the `dorks` org, for the Dorks Cloud Worker (handlemotion/dorks-cloud, which pins exact versions). Everything else in the workspace is private.

- **Versions** go through the same changesets: a PR that changes either package's API or behaviour adds a changeset for it (`pnpm changeset`, pick `@dorks/core` and/or `@dorks/shared`), and the **Release Dorks** PR bumps it with the app. No `major` before 1.0.
- **Publishing** is by hand, from an up-to-date `main` after the release PR merged, logged in to npm as a member of the `dorks` org: `pnpm publish:packages`. Each package builds itself first (`prepack`: `vp pack` to `dist/`); pnpm swaps `workspace:*` for the real version and the source `exports` for `publishConfig.exports` (`dist/`), so publish with pnpm, never `npm publish`. Versions already on npm are skipped.
- **Check what would ship:** `pnpm --filter @dorks/core pack --dry-run` (or `npm pack --dry-run` in the package for the file list).

## When something goes wrong

- **The build failed.** Fix it on `main` (any push re-runs the workflow, and it rebuilds any version without a published release), or run **Desktop release** by hand on `main`. A draft a failed run left behind is deleted first.
- **A bad release went out.** Ship a fix as the next patch. Editing a published release to a draft takes it off `releases/latest`, so installed apps stop being offered it, but anyone who updated keeps it.
- **A test build without publishing:** run **Desktop release** by hand with `unsigned`; it makes a draft pre-release `desktop-test-<n>` and touches nothing users see.

## One-time setup (done)

- Signing and notarization secrets and the updater key: [desktop.md](desktop.md#release).
- Repository settings > Actions > General > Workflow permissions: **Allow GitHub Actions to create and approve pull requests**, so the workflow can open the release PR. The release PR is opened with the workflow's token, so CI does not run on it; it only changes versions and the changelog.

## Notes

- 0.0.1 had the updater but never checked for updates, so 0.0.1 users download 0.1.0 by hand once. From 0.1.0 on, updates arrive in the app.
- The release PR is the only place versions change. Do not edit the version fields by hand; `pnpm release:version` does what the workflow does if you need it locally.
