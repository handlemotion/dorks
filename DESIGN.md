---
name: Dorks
description: A flat, quiet workspace for cloud coding agents. Off white, one radius, one weight, no shadows.
colors:
  background: "#fafafa"               # the main app frame, a slight off white (dark: oklch(0.145 0 0))
  app: "#f2f2f2"                      # onboarding's fill, thumbnails, the user bubble's family (dark: oklch(0.165 0 0))
  border: "oklch(0 0 0 / 6%)"         # full dividers and the Chat details hairline (dark: oklch(1 0 0 / 7%))
  input: "oklch(0.922 0 0)"           # form control borders; the composer fill at 50% in dark
  ring-app: "oklch(0.85 0 0)"         # focus in the main app: a darker tone of the border, never blue (dark: oklch(1 0 0 / 28%))
  brand: "#3b6be8"                    # the composer's send/stop, onboarding's step and focus, the lightbox's active thumbnail, the picker; never text
  composer: "#ffffff"                 # the prompt input, white on the off-white frame with the 6% hairline (dark: input at 50%)
  user-bubble: "oklch(0.961 0 0)"     # light grey (dark: white)
typography:
  family: "Geist Variable; Geist Mono Variable for code and paths"
  sizes: "text-sm (14px) for content, text-xs (12px) for secondary; text-lg only for a focused page's one title"
  weights: "400 and 500 only; semibold and up are mapped to 500 and fail pnpm test"
rounded:
  control: 6px                        # everything: buttons, inputs, menus, dialogs, bubbles, sidebar rows, tabs
  panel: 11px                         # Chat details (its 6px tabs + 5px inset, concentric)
  bubble: 10px                        # user messages
  thumb: 8px                          # artifact thumbnails
  composer: 18px                      # the AI Elements prompt input, as published (the one scoped exception)
  pill: 9999px                        # onboarding's step buttons only
spacing:
  edge: 20px                          # chat title and composer share one edge; the transcript is indented to 30px
  bar: "40px rows, 30px buttons and tabs, 5px around them"
  panel-inset: 4px                    # Chat details from the window and the chat
elevation: none                       # no shadows, glows or blur, except the dropdown menu's soft shadow
---

# Dorks design

The app gets out of the way of the agent's work. Everything sits on one off-white plane; sections are split by full-height or
full-width hairlines, never by cards floating on cards. The only framed thing is Chat details, and even that is the app's own fill
with a 6% hairline. When in doubt, remove: fewer borders, fewer sizes, fewer weights, fewer words.

Rules that tooling enforces live in `AGENTS.md` and `packages/ui/README.md`; this file is how to make things that fit.

## Layout

- **Frame:** `AppFrame` is a resizable split (shadcn `resizable`, react-resizable-panels v4): sidebar (275px by default, 200–420px, keeps its width on window resize, a click on the divider snaps it back, collapsible,
  remembered) | page. The divider is the resize handle. Phones get shadcn's sheet instead.
- **Chat:** `ChatSplit` puts the chat and Chat details side by side (chat 525px by default, details everything else, both at least 360px; on window resize the sidebar and the chat keep their widths and details absorbs the change; a click on the handle snaps the chat back to 525px; invisible handle in the 4px gap). Details
  hide below `lg`.
- **Edges:** the page title and the composer start 20px from the column's edge (the composer 20px from the bottom too); the transcript
  is indented to 30px, a step in from both, so messages read as the content between them. The transcript keeps `max-w-3xl`.
- **Headers** are 48px, one line, the title in regular 14px. No subtitles, no badges. A header divider exists only when it can span
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

## Type

- Two sizes, two weights. Hierarchy comes from colour (`foreground` vs `muted-foreground`) and spacing, not size.
- Copy is short and plain: `No artifacts yet`, `Sandbox ready`, `Ask for a screenshot`. Sentences end in a period; labels don't.
- Numbers that change (`+259 −80`, `2 / 5`) use `tabular-nums`; paths use mono at `text-xs` with the directory muted.

## Components to reuse (not rebuild)

| Need | Use |
| --- | --- |
| Any control, menu, dialog | `@dorks/ui/*` (shadcn, base-luma preset). Menus are shadcn `DropdownMenu`; merge related choices into one menu with labelled groups. |
| Message box | `Composer` (the AI Elements prompt input, copied exactly from `PromptInputDemo` and the Figma frame). The main button sends, or becomes Stop while the agent works. |
| An image anywhere | `ImageLightbox` + `ImageTrigger` (`@ramka/react`): one lightbox per place, so navigation stays within that place. Put `imageRef` and `morphRef` on the `<img>` so only the image morphs. |
| An empty state | `EmptyState`: a Hairline figure (`@lucasmarkes/hairline`), a title, at most one sentence, then small outline buttons only if they do something. |
| Sandbox health | `AgentStatus` at the end of the transcript (it scrolls; the scroll-to-end button takes its place): a dot and a few words; while something moves the words shimmer and the dot morphs circle → square → diamond with a quarter turn, landing on each shimmer pass (no pulsing). |
| Sidebar | `AppSidebar`: a bare 48px title bar (traffic lights, then `WindowControls`, which float in AppFrame so they never move), the owner switcher with New session, Customize, Automations and Builds, then chats grouped by repository under plain labels, Settings at the foot. Rows are `SIDEBAR_ROW` (30px, 2px apart) under one springing hover fill (`useRowHover`). |
| Chat actions | `ChatMenu`, the ••• on the right of the chat header. Archive is the icon beside the title. |
| Element context for the agent | `PreviewBrowser`'s picker (`react-grab/primitives`, same-origin frames only). |
| Resizing | `@dorks/ui/resizable` with `useDefaultLayout` to remember sizes. |

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

- Shadows (outside dropdown menus), glows, blur, gradients, glass.
- A third font size, or `font-semibold`/`font-bold`.
- Pills (except onboarding's step buttons) or radii other than the ones above.
- Cards inside panels, islands on islands, borders around sections.
- Floating labels or badges beside a title; a button that duplicates the sidebar ("New session" in a header).
- Controls that do nothing. If it isn't wired, leave it out or say plainly that it's coming.
- Hand-rolled menus, lightboxes, resizers or empty-state art when a library above already does it.
