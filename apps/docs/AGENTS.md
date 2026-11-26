# Docs agent notes

The user-facing docs (Mintlify). Run `npx mint@latest instructions` before Mintlify-specific work (publishing, domains, AI features).

- Pages are MDX with `title` and `description` frontmatter; navigation is `docs.json`.
- Write for people using the app, not contributors: what to do and what happens, in active voice and second person. Internal decisions and wire protocols belong in the repository's `docs/`.
- Facts come from the repository's `docs/` (the contract). When a feature changes there, update the page here in the same PR.
- Check with `npx mint@latest validate` and `npx mint@latest broken-links`.
