# Dorks docs

The public docs at [dorks.build/docs](https://dorks.build/docs), on [Mintlify](https://mintlify.com). Pages are MDX, navigation and branding are in `docs.json`.

```sh
npx mint@latest dev        # preview on http://localhost:3000
npx mint@latest validate   # check the build
npx mint@latest broken-links
```

Mintlify deploys from `main` through its GitHub app (docs directory `apps/docs`). The site Worker (`apps/site`) serves `/docs` from Mintlify at the edge. The internal design docs stay in the repository's `docs/`.
