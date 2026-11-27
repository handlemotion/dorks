---
name: Dorks
description: A flat, quiet workspace for cloud coding agents. Off white, one radius, one weight, no shadows.
colors:
  background: "#ffffff"               # the main app frame, white (dark: oklch(0.145 0 0))
  app: "#f2f2f2"                      # onboarding's fill, thumbnails, the user bubble's family (dark: oklch(0.165 0 0))
  border: "oklch(0 0 0 / 6%)"         # full dividers, including the one between the chat and Chat details (dark: oklch(1 0 0 / 7%))
  input: "oklch(0.922 0 0)"           # form control borders; the composer fill at 50% in dark
  ring-app: "oklch(0.85 0 0)"         # focus in the main app: a darker tone of the border, never blue (dark: oklch(1 0 0 / 28%))
  brand: "#3b6be8"                    # the composer's send/stop, onboarding's step and focus, the lightbox's active thumbnail, the picker; never text
  composer: "#ffffff"                 # the prompt input, white on the off-white frame with the 6% hairline (dark: input at 50%)
  user-bubble: "oklch(0.961 0 0)"     # light grey (dark: white)
typography:
  family: "Geist Variable; Geist Mono Variable for code and paths"
  sizes: "text-sm (13px) for the UI, text-xs (12px) for secondary, text-message (14px) only for the user's bubbles and the agent's replies; text-lg only for a focused page's one title"
  weights: "400 and 500 only; semibold and up are mapped to 500 and fail pnpm test"
rounded:
  control: 6px                        # everything: buttons, inputs, menus, dialogs, bubbles, sidebar rows, tabs
    bubble: 10px                        # user messages
  thumb: 8px                          # artifact thumbnails
  composer: 15px                      # the AI Elements prompt input (the one scoped exception)
  pill: 9999px                        # onboarding's step buttons only
spacing:
  edge: 20px                          # chat title and composer share one edge; the transcript is indented to 30px
  bar: "40px rows, 30px buttons and tabs, 5px around them"
elevation: none                       # no shadows, glows or blur, except the dropdown menu's soft shadow and the lightbox's backdrop (85% background over a blur)
---

# Dorks design

The app gets out of the way of the agent's work. Everything sits on one off-white plane; sections are split by full-height or
full-width hairlines, never by cards floating on cards. Chat details is no exception: it runs the full height
of the window, split from the chat by one full-height 6% hairline. When in doubt, remove: fewer borders, fewer sizes, fewer weights, fewer words.

Rules that tooling enforces live in `AGENTS.md` and `packages/ui/README.md`; this file is how to make things that fit.

## Layout

- **Frame:** `AppFrame` is a resizable split (shadcn `resizable`, react-resizable-panels v4): sidebar (300px by default, 200–420px, keeps its width on window resize, a click on the divider snaps it back, collapsible,
  remembered) | page. While it is collapsed, hovering its toggle peeks it: the sidebar slides 16px and fades in above the page (a
  hairline on its right edge, nothing under it moves) so a page can be picked without opening it, and slides away when the pointer
  leaves, a row is picked or Escape is pressed. The divider is the resize handle. Phones get shadcn's sheet instead.
- **Chat:** `ChatSplit` puts the chat and Chat details side by side (chat 600px by default, details everything else, both at least 360px; on window resize the sidebar and the chat keep their widths and details absorbs the change; a click on the handle snaps the chat back to 600px). Details
  run the full height, flush to the window's right edge, with no card or outer border: one full-height hairline (`border-l`) separates
  them from the chat, and the resize handle sits on it. Details hide below `lg`.
- **Chat details tabs** work like a browser's: an open-tabs strip (Progress, Artifacts, Changes (the local diff, before any PR),
  Computer, and one tab per pull request, keyed by its url, always named `#N`, never its title; a session can have many PRs, merged
  and closed ones included, and each keeps its tab; the PRs of one stack, each on the branch of the one before, share one tab,
  `Stack #N` after its root, showing the PR last opened. Under that PR's title and meta line, a `Stack` list draws the stack root first as
  dots on one vertical line (each dot in its PR's state colour, the shown PR in the foreground); a row brings its PR into the tab, and
  the merge button reads `Merge stack` from the top, since GitHub merges a stacked PR with every open PR below it), each a 28px 6px-radius tab whose icon turns into an X on hover (nothing
  moves), then `+` for a New tab. Closing the selected tab selects its neighbour; closing the last leaves a New tab. Opening a panel
  that is already open focuses it; the agent's reveals (Progress, Computer, a shown preview in Artifacts, a pull request it
  just opened) open or focus their tab.
  Open tabs and the selected one are remembered per session. A chat's details start on a New tab; Progress opens when the thread asks for it (a tool line, the status line). A **New tab** is an index in a centred 420px column: a search box
  ("Search PRs, artifacts and tools") that filters by name, then Pull requests, Tools (the panels) and Artifacts last (it can run long), each a titled list of 30px rows, 8px
  under its title, that open in the New tab's place (a PR on one row: state icon, title, `#N`, diff stats when known; a PR stacked on
  another PR's branch is indented under it; image
  thumbnails get a 15% hairline; Changes is left out once PRs have their rows); empty sections are left out, and a search with no results says `No matches`.
- **Dorks** (coordinators, `docs/crew.md`) are a sidebar group with their emoji; their workers have no rows. A dork's details are
  `CrewDetails`: the same 40px bar and 28px tabs, fixed to Sessions, Artifacts and one tab per worker PR. A worker opens inside
  Sessions under a full-width 40px bar (state, title, then full screen, stop, archive, close) with its chat below; full screen is its
  own page, the dork kept as the header's crumb and the sidebar's active row.
- **Edges:** the page title and the composer start 20px from the column's edge (the composer 20px from the bottom too); the transcript
  is indented to 30px, a step in from both, so messages read as the content between them. The transcript keeps `max-w-3xl`.
- **Headers** are 48px, one line, the title in regular 13px. No subtitles, no badges. A header divider exists only when it can span
  the full width; beside Chat details it is off, because a line that stops short of a panel looks broken.

## Bars and alignment (Chat details)

The pattern to copy for any toolbar:

- Rows are 40px. Buttons and tabs are 30px with 5px around them on every side, icons 14px, hover `bg-foreground/[0.04]`, selected
  `bg-foreground/[0.07]`. Buttons use `BAR_BUTTON` from `PreviewBrowser.tsx`.
- Icons in stacked bars line up on the same x (tab icons, Back, the PR icon are all 14px from the panel edge). Measure it with
  Playwright (`getBoundingClientRect` on the `svg`s), don't eyeball it.
- Labels in a bar share the chat title's centre line (24px from the top).
- A toggle that hides a panel and the one that shows it again sit in exactly the same spot.
- Nothing moves when a selection changes: same box selected or not, fills appear instantly (`transition-none`), only hover may fade.

## Surfaces and lines

- Separate with fill and spacing first; a hairline (`border`, 6%) when fill can't; never a shadow.
- Lines are **full or absent**: a divider spans its whole container, and the last row of a list or grid keeps its bottom line.
  Grids split tiles with each tile's right and bottom edge, the container hiding only the outer right one.
- Dropdown menus have a 6% hairline, a soft two-layer shadow (the app's only one), 32px rows with a fill that springs between
  them. Cards and dialogs have no ring or shadow.
- Radii are concentric: an inner radius is the outer minus the padding between them.
- A pull request always shows its state, from `prStatus` / `PrIcon` (`apps/web/src/components/PrStatus.tsx`), wherever it appears (PR
  header, its tab, the New tab index, the sidebar's `#N`, the files bar): open green, draft grey, merged violet, closed red. A state the
  server has not read yet is grey, never a guessed green.
- Padding is balanced: a block or list row split by hairlines (PR description, checks, files, comments) has the same padding top and bottom as
  left and right (`p-(--details-text)`, 18px in Chat details), not a fixed short height under wide side padding. Dense lists
  without lines (Progress steps, tasks, menus) keep their compact rows.

## Type

- Two UI sizes, two weights: 13px (`text-sm`) for everything you work with (nav, tabs, rows, controls, panels) and 12px (`text-xs`) for
  secondary. Conversation alone reads at 14px (`text-message`): the user's bubbles, the agent's replies, and the tool lines and status line between and under them. Hierarchy comes from colour (`foreground` vs `muted-foreground`) and spacing, not size.
- Copy is short and plain: `No artifacts yet`, `Sandbox ready`, `Ask for a screenshot`. Sentences end in a period; labels don't.
- Numbers that change (`+259 −80`, `2 / 5`) use `tabular-nums`; paths use mono at `text-xs` with the directory muted.

## Components to reuse (not rebuild)

| Need | Use |
| --- | --- |
| Any control, menu, dialog | `@dorks/ui/*` (shadcn, base-luma preset). Menus are shadcn `DropdownMenu`; merge related choices into one menu with labelled groups. |
| Message box | `Composer` (the AI Elements prompt input, copied exactly from `PromptInputDemo` and the Figma frame). The box is one 44px row (attach, the text, the main button: sends, or Stop while the agent works) until the text wraps or a file is attached; then the text takes the box and the buttons stay in their corners under it. The text is 42px in from both sides (28px buttons 8px from the edges) either way; the environment chooser (a build by name with its repositories' owners stacked, or a repository on the base machine) and model menu share a compact 28px bar under it. |
| An image anywhere | `ImageLightbox` + `ImageTrigger` (`@ramka/react`): one lightbox per place, so navigation stays within that place. Put `imageRef` and `morphRef` on the `<img>` so only the image morphs. The backdrop is the app's background at 85% over a blur of the page, so what is under it still shows. With more than one image the thumbnails run down a column on the left (brand ring on the active one); under the image one rail, the preview's: Previous, `2 / 5`, Next, the caption, then, on an image the server keeps (`imageId`), Comment (a click comments on a point, a drag on an area) and Show comments. Nothing sits in the top-left corner, where the desktop's traffic lights are; Close is top-right. |
| An empty state | `EmptyState`: a Hairline figure (`@lucasmarkes/hairline`), a title, at most one sentence, then small outline buttons only if they do something. |
| An agent turn | `ChatMessages` (`ChatBlock.tsx`) shows the whole turn in the thread, in order: the user's bubble, then every message the agent wrote (unbubbled markdown), each run of tool calls between them as one plain line with no icon, "Ran 3 commands, read 2 files ›", whose chevron opens Progress with those steps selected and marked (no inline output, no collapsibles), and any notices. The agent's thinking is never shown. Every tool call, edit and progress message lives in Chat details' **Progress** tab (`ProgressPanel.tsx`): the runs grouped by the user message they answered, each prompt a header pinned while its steps scroll, each step a 24px row (a command or path in mono, a message by its first line) with a status dot and how long ago it ran. Selecting a step (arrows, Escape to clear) opens its detail in a lower panel, resizable and remembered like every panel (a bar with its title, time and previous/next, then its input or Pierre diff and its output as sections split by full hairlines, no cards); with nothing selected the foot shows the agent's task list (its latest `TodoWrite`, or the list its `TaskCreate` and `TaskUpdate` calls built). In the thread, each run of those to-do calls is a `TodoCard` in place (`To-dos 2/4`, the whole list as that run left it, done tasks struck through): never pinned or shrunk like the ship card, so the plan reads where it changed. A search box filters (`type:shell`, `-status:failed`), and Play beside it follows the agent, selecting each new step as it lands, until a step is picked. |
| Sandbox health | `AgentStatus` at the end of the transcript (pushed down above the composer in short chats; it scrolls with longer chats and the scroll-to-end button takes its place): a dot and a few words. While the agent works the words are the step it is on (a command's description, else "Running pnpm test") and how long it has run, `14s ›`; the line is a button that opens Progress on that step; while something moves the words shimmer and the dot morphs circle → square → diamond with a quarter turn, landing on each shimmer pass (no pulsing). |
| Sidebar | `AppSidebar`: a bare 48px title bar (traffic lights, then `WindowControls`, which float in AppFrame so they never move), the org switcher with New session, Customize, Automations and Builds, then chats grouped by repository under plain labels, above it, for an org on Dorks Cloud only, its sandbox hours (`CloudPlanIndicator`: a ring and hours used or left, red with a warning from 80% or when they are used up, Subscribe on a trial; a click opens the plan's details with Manage plan; Local and Teams keep their usage in the composer's usage menu), and the account menu at the foot (`AccountMenu`: the owner's round GitHub avatar and login, opening upwards to What's new from `apps/desktop/CHANGELOG.md` on a dotted timeline, then Settings `⌘,`, Usage, Docs and Report a problem in one group, then Change server). Rows are `SIDEBAR_ROW` (30px, 2px apart) under one springing hover fill (`useRowHover`). |
| Chat actions | `ChatMenu`, the ••• on the right of the chat header. Archive is the icon beside the title. |
| A right-click menu | `openContextMenu(event, items)` (`apps/web/src/lib/contextMenu.tsx`) in the element's `onContextMenu`: the OS's own menu in the desktop app, the app's dropdown at the pointer in a browser. Items are plain labels in sentence case for what was clicked (`Open`, `Copy path`), separators between groups, no icons. Never base-ui's `ContextMenu`. The desktop app shows no webview menu anywhere else, except the native editing menu over fields and selected text. |
| Text selection | The chrome is not selectable (`user-select: none` on `body`). Fields, markdown, bubbles, `pre` and `code` are; mark any other content people copy from (a log, an editor, a diff host) `data-selectable`. |
| A running preview | An Artifacts tile (a green dot, `Running`, its port) whose thumbnail is the live page at a quarter scale. It opens `PreviewBrowser` in the Artifacts tab, and Back returns to the grid. There is no Previews tab. The page sits as one island (8px radius, a hairline in light) on a fill a step lighter than `--app`, at a chosen size scaled down to fit and centred: a 1440 × 900 desktop window (the default), a 820 × 1180 tablet or a 390 × 844 phone, picked in the bar and remembered. It sits 16px in from every side. Under it, lifted 16px off the bottom, a rail after omni's preview rail (white, a hairline, 8px radius, 2px around 28px tools, groups split by full-height hairlines): Comment on an element (one DOM picker), Comment on text, Comment on an area (a drawn rectangle and its screenshot), Rulers (red, along the whole tab's top and left edges, in page pixels with 0 at the page's corner; the page is laid out evenly in the room right of and below them; pointer guides and the size of the element under it), then Show comments; every tool ends in a comment, none writes to the chat's composer; tools get a white fill on hover and a light blue when on. |
| Comments on a preview or an image | After omni's comments (`components/preview/`): a round bubble with a tail at its bottom-left on an element's top-right corner (the first author's initial, the count of messages once answered), passages highlighted amber, the thread beside its bubble (avatar column joined by a line, Resolve and a ••• menu on the first message, a compact reply box). A comment shows only its bubble and thread (and the highlight of a text comment), never an outline of what it points at. Faces, not initials: the owner's GitHub avatar (a plain person glyph without a login) and the agent's own svgl mark (Claude, Codex, OpenCode, Antigravity), on a hairline with no fill. No comments rail. Over the page, panels carry a hairline instead of a shadow. |
| Resizing | `@dorks/ui/resizable` with `useDefaultLayout` to remember sizes; `@dorks/ui/panel-resize-handle` for the 4 × 32px grip, 6px beside the divider, shown on hover, focus and drag. A click resets the width. |

## Motion

Instant for selection, short fades for hover, springs only where a library brings them (lightbox, Hairline). Respect reduced
motion. No animation on tab switches, no layout shifts.

## How to check your work

1. Run it: `pnpm dev:mock` (the web app against the in-memory mock server). The design demo is `/#/dev/chat?dork=preview`: it has
   artifacts, images in the transcript, a preview page and every tab filled. Real chats show the empty states.
2. Look headless (Playwright, Chromium), light and dark, wide (1512px) and narrow (1180px). Never a headed browser.
3. Measure alignment and gaps from the DOM instead of judging a screenshot.
4. `pnpm --filter @dorks/web typecheck` and `node packages/ui/scripts/check-ui-rules.mjs` (shadows, weights).

## Don't

- Shadows (outside dropdown menus), glows, blur (outside the lightbox's backdrop), gradients, glass.
- A third font size, or `font-semibold`/`font-bold`.
- Pills (except onboarding's step buttons) or radii other than the ones above.
- Cards inside panels, islands on islands, borders around sections.
- Floating labels or badges beside a title; a button that duplicates the sidebar ("New session" in a header).
- Controls that do nothing. If it isn't wired, leave it out or say plainly that it's coming.
- Hand-rolled menus, lightboxes, resizers or empty-state art when a library above already does it.
