import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { Menu, X } from 'lucide-react'
import { Button } from '@dorks/ui/button'

/** Designed sidebar width in px: its default, and what a click on the divider returns it to. */
export const SIDEBAR_DEFAULT_WIDTH = 325
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 480
/** A press that moves less than this many px is a click, not a drag. */
const CLICK_SLOP = 3

/**
 * The saved width, in px. Kept here rather than with the library's `useDefaultLayout`, which saves percentages of the
 * window: the sidebar has a pixel size, and a percentage would reopen it at a different width in a different window.
 */
function readWidth(key: string) {
  try {
    const width = Number(localStorage.getItem(key))
    return width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH ? width : undefined
  } catch {
    return undefined // no storage (server render, disabled): the default width
  }
}

function writeWidth(key: string, width: number | undefined) {
  try {
    if (width === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, String(Math.round(width)))
  } catch {
    // storage full or disabled: the width just will not persist
  }
}

/**
 * Sidebar + main with a draggable divider. The width is remembered per browser under `layoutId`; a single click on the
 * divider resets it to the default.
 */
export function AppShell({
  sidebar,
  children,
  layoutId = 'app-shell',
  onSidebarResize,
}: {
  sidebar: ReactNode
  children: ReactNode
  layoutId?: string
  onSidebarResize?: (widthPx: number) => void
}) {
  const storageKey = `dorks.${layoutId}.sidebar-width`
  // Read once: it only seeds the panel, which owns its size from then on.
  const [savedWidth] = useState(() => readWidth(storageKey))
  const sidebarPanel = usePanelRef()
  const pressedAt = useRef<number | null>(null)
  const [mobile, setMobile] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)')
    const onChange = () => {
      setMobile(query.matches)
      if (!query.matches) setMenuOpen(false)
    }
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (menuOpen) closeButton.current?.focus()
  }, [menuOpen])

  if (mobile) {
    const closeMenu = () => {
      setMenuOpen(false)
      menuButton.current?.focus()
    }
    return (
      <div className="mobile-shell">
        <div className="mobile-toolbar">
          <Button ref={menuButton} variant="ghost" size="sm" aria-label="Open chats" aria-expanded={menuOpen} aria-controls="mobile-sidebar" onClick={() => setMenuOpen(true)}>
            <Menu className="size-4" /> Chats
          </Button>
        </div>
        {menuOpen && (
          <>
            <button className="mobile-backdrop" type="button" aria-label="Close chats" onClick={closeMenu} />
            <div
              id="mobile-sidebar"
              className="mobile-sidebar"
              role="dialog"
              aria-label="Chats"
              aria-modal="true"
              onKeyDown={(e) => { if (e.key === 'Escape') closeMenu() }}
              onClick={(e) => { if (e.target instanceof Element && e.target.closest('a')) closeMenu() }}
            >
              <div className="mobile-sidebar-header">
                <span>Chats</span>
                <Button ref={closeButton} variant="ghost" size="icon-sm" aria-label="Close chats" onClick={closeMenu}><X className="size-4" /></Button>
              </div>
              {sidebar}
            </div>
          </>
        )}
        <main className="app-main" inert={menuOpen}>{children}</main>
      </div>
    )
  }

  return (
    <Group
      className="app-shell"
      orientation="horizontal"
      onLayoutChanged={(_, { isUserInteraction }) => {
        // Only widths the user chose; not ones the window forced on it (main's min size), nor the reset below.
        if (isUserInteraction) writeWidth(storageKey, sidebarPanel.current?.getSize().inPixels)
      }}
    >
      {/* Pixel sizes: the sidebar keeps its width when the window resizes. */}
      <Panel
        id="sidebar"
        panelRef={sidebarPanel}
        defaultSize={savedWidth ?? SIDEBAR_DEFAULT_WIDTH}
        minSize={SIDEBAR_MIN_WIDTH}
        maxSize={SIDEBAR_MAX_WIDTH}
        groupResizeBehavior="preserve-pixel-size"
        onResize={onSidebarResize && ((size) => onSidebarResize(Math.round(size.inPixels)))}
      >
        {sidebar}
      </Panel>
      <Separator
        className="app-separator"
        // A single click resets (below). The library's double-click reset would go to `defaultSize`, the saved width.
        disableDoubleClick
        onPointerDown={(e) => {
          pressedAt.current = e.button === 0 ? e.clientX : null
        }}
        onPointerUp={(e) => {
          const start = pressedAt.current
          pressedAt.current = null
          if (start === null || Math.abs(e.clientX - start) >= CLICK_SLOP) return
          sidebarPanel.current?.resize(SIDEBAR_DEFAULT_WIDTH)
          writeWidth(storageKey, undefined)
        }}
      />
      <Panel id="main" minSize="40%">
        <main className="app-main">{children}</main>
      </Panel>
    </Group>
  )
}
