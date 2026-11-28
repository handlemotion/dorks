---
"@dorks/desktop": patch
---

Agents are stopped before they push to the branch of a PR that already merged (or closed), and told to open a new PR from main instead; a push that still lands there is reported to the agent once.
