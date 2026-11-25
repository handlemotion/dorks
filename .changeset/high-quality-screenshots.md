---
"@dorks/desktop": patch
---

Improved screenshot quality across the agent harness: `screenshot_share` now requires `url` or `path` (no silent 1x desktop fallback), flags JPEG or low-resolution captures, reminds agents to use `deviceScaleFactor: 2` PNGs, and inline chat screenshots serve higher-resolution (`1920px`, quality 92) WebP copies.
