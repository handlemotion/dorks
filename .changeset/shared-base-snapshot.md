---
"@dorks/desktop": patch
---

Every Dorks install on a Boat account now shares one base snapshot per installer version instead of saving its own, so extra installs and dev servers no longer fill the account with billed saved snapshots. An install on its old per-install snapshot switches on its next start and deletes the old one.
