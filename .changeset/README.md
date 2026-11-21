# Changesets

A PR that changes what users get in the Dorks app adds a changeset: `pnpm changeset`, pick `@dorks/desktop`, choose the bump and write one line for the release notes. The release workflow gathers them into the "Release Dorks x.y.z" PR; merging that PR builds, signs and publishes the release. See `docs/releasing.md`.
