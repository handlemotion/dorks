---
"@dorks/desktop": patch
---

Stop gate now detects commits pushed to a branch whose pull request was already merged or closed, notifying the agent so it opens a new pull request instead of silently dropping the change.
