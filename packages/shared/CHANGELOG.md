# @dorks/shared

## 0.2.0

### Minor Changes

- [#282](https://github.com/handlemotion/dorks/pull/282) [`c758922`](https://github.com/handlemotion/dorks/commit/c7589229b3a99e5b127c2a1e8f635db226516620) Thanks [@handlemotion](https://github.com/handlemotion)! - Skills: the skills already on your Mac (~/.agents/skills and ~/.claude/skills) now reach every session automatically and follow edits to their folder. Remove one from Dorks only, or from your Mac for every agent.

- [#278](https://github.com/handlemotion/dorks/pull/278) [`1cd82bc`](https://github.com/handlemotion/dorks/commit/1cd82bc3b53105abc205ab0e346c3aeaadfae011) Thanks [@handlemotion](https://github.com/handlemotion)! - Move to cloud: in Settings › Organization, owners and admins of a Teams or Cloud organization that runs on their Mac can move it to Dorks Cloud with its sessions, chats, automations, MCP servers, skills and shared variables.

### Patch Changes

- [#270](https://github.com/handlemotion/dorks/pull/270) [`467b690`](https://github.com/handlemotion/dorks/commit/467b6908f69de241fce6a724657ebe717489faad) Thanks [@handlemotion](https://github.com/handlemotion)! - First npm release: `@dorks/core` (the server's runtime-neutral lifecycle reducer, Boat driver, secret envelopes, bridge auth, schedules, stream normalizer and notification renderer, moved out of `apps/server`) and `@dorks/shared`, built to `dist/` and checked to run on Cloudflare Workers.
