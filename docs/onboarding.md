# Onboarding design brief

First run walks a new owner from nothing to a first session in four full-page steps. Only what the owner has to type is a step: the base snapshot builds in the background, and the public URL is asked for where sessions are created. The code is `apps/web/src/routes/_conn/onboarding.tsx` and `apps/web/src/components/onboarding/`.

## What the references taught us

Studied on Mobbin (web, desktop-class onboarding): Linear, Twenty, Air, Sana.

| Reference | Take |
|---|---|
| [Linear onboarding](https://mobbin.com/flows/cbaf58a9-fd84-4afe-b214-e65b24484013) | The model to copy. Centered column on an empty page: logo or nothing, one heading, one muted sentence, one form or one button, tiny progress dots pinned to the bottom, and a quiet text link ("I'll do this later") under the primary button for optional steps. No navigation chrome until the end. |
| [Linear workspace step](https://mobbin.com/flows/cbaf58a9-fd84-4afe-b214-e65b24484013) | A single card with labeled fields and one primary button below it. Fields explain themselves with a sentence, not a tooltip. |
| [Twenty onboarding](https://mobbin.com/flows/c05af68f-a703-4104-8e9a-c92c82cafc9d) | Inline field errors in plain words ("Name can not be empty"), and the primary button stays disabled until the step can succeed. |
| [Air onboarding](https://mobbin.com/flows/8c0164d5-3370-4300-b87d-b97910b917dd) | One question per screen reads calmer than a long form. Avoid the modal-over-app pattern: our steps are the whole window. |
| [Sana invite](https://mobbin.com/flows/e544fc0c-bc6b-4e45-b693-74f9541b7d6a) | Heavy rounding and a quiet panel on a calm background make a single action feel safe. |

## Rules

1. **One step, one page.** A 450px column: a heading, one sentence, the step's content, then the step buttons. A single field stands on its own (no card, no label: the heading names it); a card is only for content that needs grouping, like the intro list or a list of things to connect. No sidebar, no app chrome, no step list. Copy is two lines at most, in the subtitle and in dialogs: if it wraps to three, cut it (details belong in the docs, or in the error when something fails). The design is in Figma (Dorks file, `(1) /intro` and `(3) /ai`); Boat and GitHub follow the same layout.
2. **Progress is four dots**, bottom center, the current one in the brand blue (`bg-brand`). Not clickable: steps are answered in order. The route renders each step from one `Record<OnboardingStepId, View>` and the dots from the same `step`, so they cannot disagree.
3. **Step buttons are 40px pills, centered under the card**: Back (ghost, from step two) and the primary action ("Let's go", "Continue"). Pills are only for moving between steps; every other button and input is 6px (`--control-radius`). Controls on these pages are 40px (`lg`), where the app uses 36 or 32. The primary is never disabled for validation: pressing it with something missing toasts what is missing. It is only disabled while it works, and shows `…ing` then.
4. **No skips.** Every step is required to create a session. Anything that is not a question for the owner (the snapshot build, the tunnel) is not a step.
5. **Validation and failures are toasts**, top center (`notify` in `Frame.tsx`, the app-wide Sonner `Toaster` in `main.tsx`), in plain words. Nothing is written under the fields, and no stack traces.
6. **Resumable.** The server's settings decide where you start (`firstIncomplete` in `lib/onboarding.ts`). Quit at step three and the app reopens at step three. The intro shows once (`localStorage`), and only when nothing is configured yet. The last step leaves only once the refreshed settings say onboarding is answered, so the app does not bounce back.
7. **Secrets are write-only.** Token inputs are `type=password`, are cleared after saving, and a saved one shows as a placeholder ("A key is saved"), never its value.
8. **Tokens only.** The page is the flat app fill (`app-backdrop`, `#f2f2f2`); cards and lone fields are `bg-surface` with the `--surface-line` hairline in light (white on `#f2f2f2` is under 1.15:1, see `contrast.mjs`). The brand circle (`components/BrandCircle.tsx`, `--brand-line`) sits behind it, the one decoration, copied from the Figma reference at the same proportions.
9. **Connect lists.** The AI and GitHub steps are a card of 48px rows (`components/onboarding/List.tsx`): logo, name, and Connect / Connected / Soon. A row only shows its state; connecting is a separate action, so it opens a dialog (`ConnectDialog`) with the instructions, the field, Cancel and Save. Rows never expand in place. Provider logos come from svgl (`apps/web/src/assets/providers/`).

## Steps

| # | Step | Done when |
|---|---|---|
| 1 | Intro: heading, a card of what Dorks is, Let's go | any setting exists, or the owner pressed Get started |
| 2 | Boat API key. Checked against Boat's `GET /limits` before it is saved (by `POST /api/boat/check`, and again by the server on save), so a wrong or expired key, a free trial, a blocked wallet or a wrong organization is reported here; the organization field appears only when Boat refuses one. Saving it queues the base-snapshot build on the server | `boatKey` |
| 3 | AI: rows for Claude (pasted token), Codex (Boat environment name, checked against Boat's environment list on save) and Grok (Soon, not supported yet). One of them is enough | `claudeToken` or `boatEnvironment` |
| 4 | GitHub: rows for the GitHub CLI login (desktop, native consent) and a fine-grained token, with the required permissions listed | `github.configured` |

Then the app opens on the new-session screen (`components/SetupStatus.tsx`), which shows what still stands between the owner and a session:

- **Base snapshot**: "Preparing Boat, step n of 7" with progress while it builds, the reason and Retry when it failed, or a Prepare Boat button when nothing was started (a key saved before builds started themselves). Create stays disabled until a snapshot is set.
- **Public URL**: the desktop app opens its own private tunnel with nothing to approve, so this shows only when it could not (with the reason): a line saying sessions will not start, pointing at Settings (desktop) or `DORKS_PUBLIC_URL` (server by hand).

Using a hand-built snapshot, billing a team wallet and setting your own public URL live in Settings only.

## Window chrome (desktop)

The onboarding window shows no traffic lights; the main app does. The page calls `invoke('set_window_mode', { mode: 'onboarding' })` on entering onboarding and `{ mode: 'app' }` when the app view mounts (it is a no-op in a browser). The shell owns what each mode means (title bar, vibrancy). The top 40px of every onboarding page is a drag region (`data-tauri-drag-region`) because the window has no title bar in this mode.

## Server side

- **Progress is derived, not stored.** Which steps are done comes from the settings the server already keeps (`lib/onboarding.ts`); there is no separate onboarding record to drift out of sync. Only "pressed Get started" lives in the browser.
- **The server checks provider values on save** (`PUT /api/settings`), whatever the client checked first, and refuses Boat's and GitHub's definite rejections with their reason. An unreachable provider does not block the save.
- **The snapshot build is durable.** Saving the Boat key queues it in the same request; a process that stops before that queues it on the next start; a build interrupted mid-way is rerun (`recoverSnapshotBuild`). A failed build waits for the owner's Retry.
- **One gate for a new session** (`services/setup.ts`): Boat, agent, GitHub, base snapshot, public URL, in that order, so the refusal always names the next thing to do.
- **Logs**: the server writes `settings saved: <field names>` (never values) and each build's queue, ready and failure to stderr, which the desktop app keeps in `logs/server.log`.
