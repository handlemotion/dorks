# Onboarding design brief

First run walks a new owner from nothing to a first session in seven full-page steps. The code is `apps/web/src/routes/_conn/onboarding.tsx` and `apps/web/src/components/onboarding/`.

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

1. **One step, one page.** A heading, one sentence, one form or one button. No sidebar, no app chrome, no step list.
2. **Progress is seven dots**, bottom center, current one filled. Not clickable: steps are answered in order. Back is a small text button, top left.
3. **Primary action is the only filled button**, full width of the column, labelled with the verb ("Continue", "Prepare Boat", "Start your first session"). It is disabled until the step can succeed and shows `…ing` while it works.
4. **Skip only where truly optional.** Only the public URL step has "Skip for now", and it says what breaks (sandboxes cannot reach this Mac, so sessions will not start until it is set). Boat key, snapshot, agent and GitHub are required to create a session.
5. **Errors are inline, plain, and under the field** that caused them, in the destructive color, with `role="alert"`. No toasts, no stack traces.
6. **Resumable.** The server's settings decide where you start (`firstIncomplete` in `lib/onboarding.ts`). Quit at step four and the app reopens at step four. Welcome shows once (`localStorage`), and only when nothing is configured yet.
7. **Secrets are write-only.** Token inputs are `type=password`, are cleared after saving, and a saved one shows as a placeholder ("A key is saved"), never its value.
8. **Tokens only, no decoration.** Surfaces use shadcn tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-line`, `text-destructive`). The desktop shell supplies the glass backdrop behind the page, so cards and inputs stay on token surfaces and the page itself is transparent.

## Steps

| # | Step | Done when | Skippable |
|---|---|---|---|
| 1 | Welcome | any setting exists, or the owner pressed Get started | no |
| 2 | Boat API key (+ optional team org) | `boatKey` | no |
| 3 | Prepare Boat (one-click snapshot build with progress, retry, stale warning; hand-entered snapshot as a disclosure) | `baseSnapshotId` | no |
| 4 | Agent: Claude Code (pasted token) is the default; "Use ChatGPT (Codex) instead" is a small secondary switch (Boat environment name). One of them is enough | `claudeToken` or `boatEnvironment` | no |
| 5 | GitHub: "Use my gh CLI" (desktop, native consent) or a fine-grained token, with the required permissions listed | `github.configured` | no |
| 6 | Public URL: the tunnel (wurmhol: one "Approve this Mac" click in the browser, no token to paste) or an address of your own, so sandboxes can reach this Mac | `publicUrlConfigured` | yes |
| 7 | Done: create the first session | | |

## Window chrome (desktop)

The onboarding window shows no traffic lights; the main app does. The page calls `invoke('set_window_mode', { mode: 'onboarding' })` on entering onboarding and `{ mode: 'app' }` when the app view mounts (it is a no-op in a browser). The shell owns what each mode means (title bar, vibrancy). The top 40px of every onboarding page is a drag region (`data-tauri-drag-region`) because the window has no title bar in this mode.

## Server side

- **Progress is derived, not stored.** Which steps are done comes from the settings the server already keeps (`lib/onboarding.ts`); there is no separate onboarding record to drift out of sync. Only choices that are not settings (having pressed Get started) live in the browser.
- **The server checks provider values on save** (`PUT /api/settings`), whatever the client checked first. The Boat key is checked with Boat's `GET /limits` (a wrong or expired key, a free trial, a blocked wallet or a wrong organization is refused with the reason), a Codex environment against Boat's environment list, a GitHub token with `GET /user`. An unreachable provider does not block the save.
- **The snapshot build is durable.** Saving the Boat key queues it in the same request (or retries a failed one); a process that stops before that queues it on the next start; a build interrupted mid-way is rerun (`recoverSnapshotBuild`). A failed build is otherwise never retried by itself.
- **One gate for a new session** (`services/setup.ts`): Boat, agent, GitHub, base snapshot, public URL, in that order, so the refusal always names the next thing to do.
- **Logs**: the server writes `settings saved: <field names>` (never values) and each build's queue, ready and failure to stderr, which the desktop app keeps in `logs/server.log`.
