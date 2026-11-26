# Effect UI migration

The web app (`apps/web` and `packages/ui`, React 19 + TanStack Router + shadcn on Base UI + Tailwind) is moving to
[Effect UI](https://ui.effect.website/) (`@effect/ui`, the Elm architecture on Effect v4, the successor of Foldkit 0.x) and its
headless kit `@effect/ui-kit`. Not React. The move is incremental: Effect UI components run inside the React app as **islands** and
replace it leaf by leaf, then parent by parent, until the root is Effect UI and React goes.

Effect UI is in public preview. Read `node_modules/@effect/ui/AGENTS.md` (the official agent guide, matching the installed build)
before writing any Effect UI code; `apps/web/src/effect/AGENTS.md` points there. This page is the plan and the conventions; the guide
is the API.

## Status

- **Interop works, in the direction we need first.** An Effect UI component mounts into a DOM node that React owns, receives new props
  from React and sends events back (below, verified in the running app). The reverse, a React component inside an Effect UI view, is
  possible through a Mount (Effect UI's hook for work on a host node) that calls `createRoot`; it is not built yet (phase 3 needs it).
- **Ported:** Settings > Appearance (`apps/web/src/effect/settings/AppearancePage.ts`), with the settings kit pieces it needs
  (`effect/settings/kit.ts`, `effect/settings/SettingsSelectRow.ts`) and the Base UI Select replaced by `@effect/ui-kit`'s `Select`,
  drawn with `packages/ui`'s select classes. Headless Chromium against `pnpm dev:mock`: the closed page and the dark theme are
  pixel-identical to the React page (0 differing pixels at 2x), the open popup differs by 6 of 3.7M pixels (antialiasing), trigger and
  popup land on the same boxes (112x32 trigger, 144x108 popup over it, 6px radius, 13px/400). Mouse pick, keyboard (ArrowDown, ArrowUp,
  Enter), Escape (focus back on the trigger), outside press, and unmount/remount on navigation all behave as before.
- **Pinned build:** `@effect/ui` and `@effect/ui-kit` from pkg.pr.new at commit `fb618d4` (2026-11-26, the first with SVG builders,
  which icons need), `effect` ^4.1.5. pnpm warns about the unmet `@effect/ui` peer of the kit: expected, ignore it.

## How the islands work

`apps/web/src/effect/`:

| File | What |
|---|---|
| `island.ts` | `makeIsland`: a thin Effect UI root around one ported component. It keeps React's props in its Model (`ReceivedProps`), renders the component with them, and re-emits its events. |
| `islands.ts` | Every island, one per ported leaf. The only module React loads from `src/effect` (lazily). |
| `EffectIsland.tsx` | The React side: mounts the island with `BrowserHost.mountEffect` into a `display: contents` div, `Root.send`s new props (compared by value), passes events to `onEvent`, interrupts the mount on unmount. `head: false`: React owns the document head. |
| `lazyIsland.tsx` | `lazyIsland(() => import('../../effect/islands').then((m) => m.X))`: a React component that loads Effect, `@effect/ui`, the kit and the island in their own chunks. |
| `icons.ts` | Lucide icons drawn with `h.svg`/`h.path` and lucide-react's attributes and classes. |
| `settings/` | The ported page and its kit. |

Rules for a ported component:

- It is a normal Effect UI component: props and events are Schemas, it knows nothing of React or the island. When its React parent is
  ported, the parent renders it directly (`AppearancePage(h, { props, onEmit })`) and its island is deleted.
- Props crossing the island are Schema data (no functions, no React nodes). Callbacks become events; React children become slots or
  stay on the React side.
- Popups (`Select`, `Menu`, `Dialog`, `Popover`, `Tooltip`) render in the browser's top layer, so they need no portal and escape
  React's `overflow: hidden`. Reset the browser's popover box on the positioner and keep a 10px margin (Tailwind's preflight zeroes
  margins, which the kit reads as the viewport gap): see `POSITIONER` in `SettingsSelectRow.ts`.
- Styling is unchanged: the same Tailwind classes and tokens. Tailwind scans `.ts` files, so classes in `h.div.class(...)` compile. The
  kit's data attributes match Base UI's (`data-open`, `data-closed`, `data-highlighted`, `data-selected`, `data-side`,
  `data-starting-style`, `data-ending-style`), so `packages/ui` class strings work as they are. Copies of shadcn classes must pass
  `packages/ui/scripts/check-ui-rules.mjs`: drop `shadow-*` (a no-op under the theme anyway) and `box-shadow` in transition lists.
- Typecheck: `@effect/ui` needs `exactOptionalPropertyTypes`, which the React code does not pass (231 errors). `apps/web/tsconfig.effect.json`
  checks `src/effect` with it, and `pnpm --filter @dorks/web typecheck` runs both configs. Turn it on for the whole app once React is gone.
- Name messages, events and Commands as the guide's **Naming** section says (`PickedSelectChoice`, `RequestedOpenSelect`, never `Set*`).

## Bundle

Measured with `vp build` (`apps/web/dist/client`), the Appearance island against the same commit without it:

- Entry chunk: 480,506 B -> 480,922 B (+416 B, +192 B gzip): `lazyIsland` only.
- Lazy chunks, fetched the first time Appearance opens: +276 KB raw, +96 KB gzip in total (`EffectIsland` 33 KB / 13 KB gz, the island with
  the kit's Select 65 KB / 24 KB gz, the rest Effect and the `@effect/ui` runtime). Paid once; later islands add only their own code.
- Before `lazyIsland`, the same code sat in the entry chunk (+274 KB raw / +93 KB gz on first paint). Keep every island behind it until
  the root is Effect UI. Do not put `@effect/ui` in a vendor chunk (guide, **Code splitting**).

## Inventory and mapping

### packages/ui (shadcn on Base UI)

| Component | Today | Effect UI |
|---|---|---|
| `button` | Base UI Button + cva | kit `Button` (view function) + the same cva classes |
| `input`, `textarea`, `label`, `native-select` | Base UI Input / plain | kit `Input`; `h.textarea`, `h.label`, `h.select` |
| `field`, `input-group` | cva layout | view functions; kit `Field`/`Fieldset`/`Form` and `Validation` for forms |
| `select` | Base UI Select | kit `Select` (**done**, `effect/settings/SettingsSelectRow.ts`) |
| `checkbox`, `switch`, `radio-group`, `toggle`, `toggle-group` | Base UI | kit `Checkbox`, `Switch`, `RadioGroup`, `Toggle`, `ToggleGroup` |
| `dialog`, `sheet` | Base UI Dialog | kit `Dialog` (`AlertDialog` for confirms), `Drawer` for the sheet |
| `dropdown-menu`, `context-menu` | Base UI Menu / ContextMenu | kit `Menu`, `ContextMenu` (keep the one soft dropdown shadow class) |
| `popover`, `hover-card`, `tooltip` | Base UI Popover / PreviewCard / Tooltip | kit `Popover`, `PreviewCard`, `Tooltip` + `TooltipProvider` |
| `tabs`, `collapsible`, `progress`, `scroll-area`, `separator`, `avatar` | Base UI | kit `Tabs`, `Collapsible`, `Progress`, `ScrollArea`, `Separator`, `Avatar` |
| `command` | cmdk | kit `Combobox` / `Autocomplete` (inline list); cmdk's fuzzy ranking becomes our own filter |
| `sonner` | sonner | kit `ToastProvider` (a Provider: components `$.send` it toasts) |
| `message-scroller` | own (stick to bottom) | kit `VirtualList` (follows the end, loads earlier items) |
| `attachment`, `badge`, `bubble`, `item`, `marker`, `alert`, `card`, `empty`, `skeleton`, `message`, `trace`, `code-block`, `questionnaire` | cva + `useRender` | view functions returning a builder (`Card(h).children(...)`); `render` props become builders the caller passes |
| `sidebar` (726 lines) | own: context, cookie, mobile sheet | a `SidebarProvider` (shares open/collapsed) + view functions; `Drawer` on phones |
| `resizable`, `panel-resize-handle` | react-resizable-panels v4 | **gap**: no splitter in the kit. A headless `Splitter` component: a Mount with pointer capture, ARIA `separator`, keyboard, snap-on-click, sizes in the Model |
| `fluid-hover-highlight` | motion layout animation | **gap**: a Mount that moves one highlight to the hovered row's measured rect with a CSS transition |
| `markdown`, `markdown-code-block` | `@pierre/words/react`, Shiki | `@pierre/words/html` (framework-free) rendered by a Mount; code highlighting unchanged |
| `ai-elements/*` (21) | AI Elements, AI SDK | only the dev demo route (`/dev/ai-elements`) uses them; the composer is our own copy. Do not port; drop with React |

### Third-party libraries in apps/web

| Library | Used by | Effect UI |
|---|---|---|
| `@tanstack/react-router` (hash history, file routes, code splitting) | routes/, 30 files | `Route` + `Router`, `BrowserRouter.layerHash` (hash routing exists), `Component.lazy` per page. Last: it is the root |
| `@dnd-kit/react` | `ChatList` reordering | Effect UI's own `draggable`/`dropTarget` (HTML drag and drop) for simple cases, or `@dnd-kit/dom` (framework-free) in a Mount for sortable lists |
| `@pierre/diffs` (diffs, editor, worker pool) | `diffs/`, `PullRequestPanel`, `Files` | its framework-free API (`@pierre/diffs`, worker) in a Mount; keep the worker pool |
| `@pierre/trees` | `chat-details/Files` | `@pierre/trees/web-components` through `Html.customElement` |
| `@ramka/react` lightbox | `ImageLightbox` | **gap**: React-only. Port it on kit `Dialog` (375 lines) or host it as React-in-Effect (Mount + `createRoot`) |
| `motion` | `fluid-hover-highlight`, message animations | CSS transitions/animations keyed on the kit's data attributes; `$.viewTransition` for list and page morphs |
| `mermaid` | `MermaidBlock` | a Mount (it is already framework-free and lazy) |
| `react-grab` | `PreviewBrowser` element picking | its `primitives` entry in a Mount, or keep that panel in React longest |
| `next-themes` | theme, `ThemeSync`, 7 readers | a `ThemeProvider` component: `shares` the resolved theme, `HtmlSubscription` media query for system, a Command that sets `html.class` and the stored choice |
| `lucide-react` | everywhere | `effect/icons.ts`; generate it from the `lucide` package's icon nodes instead of by hand once more than a few icons move |
| `@lucasmarkes/hairline/react` | `EmptyState` | its framework-free root export in a Mount (the figures react to the pointer) |
| `uqr` | `PhonePage` QR | `encode` to a matrix, drawn with `h.svg` + `h.rect` (no raw HTML in Effect UI views) |
| `@ai-sdk/react`, `ai` | AI Elements demo only | none needed |

### State

| Today | Effect UI |
|---|---|
| `@dorks/client` `Store`s (`subscribe`/`getSnapshot`, the `useSyncExternalStore` contract) read by 34 hooks in `@dorks/client/react` (`useSettings`, `useDorks`, `useDork`, `useDorkEvents`, `useConnection`, `useCloudPlace`, ...) | a `DorksClient` Effect service wrapping the existing client (provided by the root). App-wide live state (settings, connection, dorks list, cloud place) becomes Providers whose `shares` the readers list in `reads`, fed by a Subscription that turns a Store into a `Stream`. Per-screen live data (one dork's events, a PR) is a Subscription keyed on the id prop. The client needs no change: Stores are already framework-neutral |
| one-shot reads (`useGithubRepos`, `useSkills`, `useSnapshot`, ...) | `Query.Service` per read, listed in the component's `queries`; invalidated by the Commands that change them |
| `actions.*` + `usePending` (pending flag, error string) | a `Command.Service` per action (`settings/UpdateSettings`, ...) returning `Succeeded*`/`Failed*` messages; `h.isRunning(Command)` replaces `pending` |
| component `useState` (drafts, open menus, tabs) | the component's Model |
| React context (`useSettingsAccess`, sidebar, tooltip delay) | Providers |
| `localStorage` helpers (`storedOrder`, open tabs, drafts) | `KeyValueStore` service in Commands; restore through `init` Commands |
| TanStack search params (`useSearch`) | typed `Route` search, `Router.patchSearch` |

## Plan

Each phase is a set of tasks that can run in parallel: one worker per row, owning only the files listed, plus its own island in
`effect/islands.ts` (append-only; rebase on conflicts) and its own folder under `apps/web/src/effect/`. A ported React file keeps its
export name and becomes a thin `lazyIsland` wrapper, so its callers do not change. Every task: same pixels (headless before/after at 2x,
light and dark), same keyboard behaviour, `pnpm --filter @dorks/web typecheck`, `pnpm check`, `pnpm --filter @dorks/ui test`.

### Phase 1: settings leaves (islands, React keeps the data)

Shared first, one task, blocks the rest of phase 1: **kit** — finish `effect/settings/kit.ts` (all of `components/settings/kit.tsx`:
inputs, value/button rows, footer, status, facts, status dot) and `effect/ui/` view functions for `button`, `input`, `switch`,
`EmptyState` (hairline Mount). Owns `effect/settings/kit.ts`, `effect/ui/*`, `effect/icons.ts`.

Then in parallel:

| Task | Owns |
|---|---|
| Your computer | `components/settings/ComputerPage.tsx`, `effect/settings/ComputerPage.ts` |
| Phone (QR as SVG, countdown Subscription) | `components/settings/PhonePage.tsx`, `effect/settings/PhonePage.ts` |
| AI accounts, GitHub | `components/settings/PersonalPages.tsx` (except Appearance), `AntigravitySignIn.tsx`, `effect/settings/PersonalPages.ts` |
| Cloud account, Organization, Move to cloud | `settings/CloudPage.tsx`, `TeamPage.tsx`, `MoveToCloud.tsx`, `effect/settings/{Cloud,Team}*.ts` |
| Server pages (Boat, snapshot, sessions, variables, Sentry, setup) | `settings/OrganizationPages.tsx`, `effect/settings/OrganizationPages.ts` |

### Phase 2: data in Effect, settings as one Effect UI subtree

| Task | Owns |
|---|---|
| `DorksClient` service, Store-to-Stream, Providers for settings/connection/cloud place, Commands for `actions.*` | `apps/web/src/effect/client/` (no change to `packages/client`) |
| `ThemeProvider` (replaces next-themes for Effect UI readers; React keeps next-themes until phase 4) | `effect/theme/` |
| Settings route as one island: `SettingsSidebar` + `$page` in Effect UI, pages read Providers instead of props | `routes/_conn/settings/*`, `components/settings/SettingsSidebar.tsx`, `pages.tsx`, `access.tsx`; deletes the phase 1 islands |
| Primitive gaps: `Splitter` (resizable), hover highlight, toast stack on `ToastProvider` | `effect/ui/Splitter.ts`, `effect/ui/HoverHighlight.ts`, `effect/ui/Toasts.ts` |

### Phase 3: feature areas (each a route-level island)

| Task | Owns |
|---|---|
| Builds (list, page, runs, dialogs) | `components/builds/*`, `routes/_conn/_app/builds.tsx` |
| Plugins and skills | `components/plugins/*`, `components/SkillsTab.tsx`, `routes/_conn/_app/plugins.tsx` |
| Automations | `components/automations/*`, `routes/_conn/_app/automations.tsx` |
| Onboarding, auth, invite | `components/onboarding/*`, `routes/_conn/onboarding.tsx`, `auth.tsx`, `invite.$id.tsx` |
| Chat details panels (Progress, PR, Files, Artifacts, New tab) with `@pierre/diffs`/`@pierre/trees` Mounts | `components/chat-details/*`, `ChatDetails.tsx`, `CrewDetails.tsx`, `ProgressPanel.tsx`, `PullRequestPanel.tsx`, `components/diffs/*` |
| Preview browser and comments (react-grab Mount) | `PreviewBrowser.tsx`, `components/preview/*` |
| React-in-Effect bridge (Mount + `createRoot`) for what has no port yet (lightbox) | `effect/ReactIsland.ts` |

### Phase 4: the chat and the shell

Sequential, after phase 3: the transcript (`ChatBlock`, `Reply`, `SessionChat`, `message-actions`, `VirtualList`), the composer
(`ChatComposer`, `ComposerMenu`, `EnvironmentPicker`, `UsageMenu`, `Combobox` for the / and @ menus), the sidebar and frame
(`AppSidebar`, `AppFrame`, `ChatList` with drag and drop, `Splitter`), then the root: `Router` with `layerHash`,
`BrowserHost.mount` in `main.ts`, React, TanStack Router, Base UI, next-themes and the islands removed, `exactOptionalPropertyTypes`
on for the whole app. `packages/ui`'s React components go when nothing imports them (`apps/mobile` and `apps/site` do not).

## Risks

- **Preview software.** No npm release, no upgrade guide, APIs change between commits (SVG builders landed while this spike ran). Pin one SHA, bump it deliberately in its own PR with a before/after pass, and read the installed guide, not the website.
- **Bundle.** Effect + `@effect/ui` + the kit cost about 96 KB gzip once. Lazy until the root moves; after phase 4 React and React DOM (about 60 KB gz),
  Base UI, TanStack Router, motion, cmdk and sonner leave, which should make it a wash.
- **Gaps.** No splitter, no layout animation library, React-only lightbox; `cmdk`'s ranking. Each has a plan above, none is free.
- **Two type configs** until React is gone (`exactOptionalPropertyTypes`).
- **Behaviour parity is per component.** The kit follows Base UI closely (same data attributes, same aligned select, a similar guard that
  ignores an outside press in the instant the popup opens), but every port needs the keyboard and pointer pass, not only screenshots.
- **Dev only:** one run saw a select stuck in its exit state right after a Vite hot update of the island's modules; it did not reproduce
  in 24 later runs. Reload after editing island code if a popup misbehaves.
