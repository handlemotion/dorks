---
"@dorks/desktop": patch
---

Preview comments and PR notifications no longer land in the middle of a turn the agent started on its own (after a background task finished), where it could overlook them; they now arrive as their own turn once it ends. The session also shows as working during those turns instead of idle.
