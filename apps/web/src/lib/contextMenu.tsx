import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@dorks/ui/dropdown-menu'
import { isDesktop, openExternal } from './desktop'

/**
 * Right-click menus. In the desktop app they are the OS's own menus (Tauri's `Menu.popup`), built from what was clicked; in a browser
 * the same items show in the app's dropdown menu at the pointer (`ContextMenuHost`, mounted once). The desktop app never shows the
 * webview's own menu (Reload, Inspect Element) except over text fields and selected text, where it is the native Cut, Copy and Paste
 * menu: `installDesktopContextMenu`.
 */
export type ContextMenuItem = { label: string; onSelect: () => void; disabled?: boolean; destructive?: boolean } | 'separator'

type Point = { x: number; y: number }

interface TauriMenu {
  popup: () => Promise<void>
  close: () => Promise<void>
}
interface TauriMenuApi {
  Menu: { new: (opts: { items: unknown[] }) => Promise<TauriMenu> }
}
const nativeMenu = () => (window.__TAURI__ as { menu?: TauriMenuApi } | undefined)?.menu

/** Shows `items` at the pointer for a `contextmenu` event, natively in the desktop app. Separators at the ends or doubled are dropped. */
export function openContextMenu(event: { preventDefault: () => void; stopPropagation?: () => void; clientX: number; clientY: number }, items: ContextMenuItem[]) {
  event.preventDefault()
  event.stopPropagation?.()
  const list = tidy(items)
  if (!list.length) return
  showContextMenu({ x: event.clientX, y: event.clientY }, list)
}

export function showContextMenu(at: Point, items: ContextMenuItem[]) {
  const api = isDesktop() ? nativeMenu() : undefined
  if (!api) return setWebMenu({ at, items, key: Date.now() })
  // An action runs after the menu closes, so a handler that opens a dialog or moves focus does it on the page, not under the menu.
  const options = items.map((item, i) =>
    item === 'separator' ? { item: 'Separator' } : { id: `dorks-context-${i}`, text: item.label, enabled: !item.disabled, action: () => setTimeout(item.onSelect, 0) },
  )
  // Only a menu that could not be built falls back to the web one; a popup that fails once shown must not show a second menu.
  void api.Menu.new({ items: options }).then(
    (menu) =>
      menu
        .popup()
        .catch(() => {})
        // The chosen item's action is delivered over its own channel right after; free the menu once it surely has been.
        .finally(() => setTimeout(() => void menu.close().catch(() => {}), 5000)),
    () => setWebMenu({ at, items, key: Date.now() }),
  )
}

function tidy(items: ContextMenuItem[]) {
  const out: ContextMenuItem[] = []
  for (const item of items) if (item !== 'separator' || (out.length && out[out.length - 1] !== 'separator')) out.push(item)
  while (out[out.length - 1] === 'separator') out.pop()
  return out
}

/** Copies `text` and says so. */
export const copyText = (text: string, what = 'Copied') => void navigator.clipboard.writeText(text).then(() => toast(what))

type WebMenu = { at: Point; items: ContextMenuItem[]; key: number } | undefined
let webMenu: WebMenu
const listeners = new Set<() => void>()
function setWebMenu(next: WebMenu) {
  webMenu = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** The browser's stand-in for the native menu: the app's dropdown, anchored at the pointer. Mount once near the root. */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(subscribe, () => webMenu)
  if (!menu) return null
  const { x, y } = menu.at
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }
  return (
    <DropdownMenu key={menu.key} open onOpenChange={(open) => !open && setWebMenu(undefined)} modal={false}>
      <DropdownMenuContent anchor={anchor} sideOffset={2} className="w-max min-w-40">
        {menu.items.map((item, i) =>
          item === 'separator' ? (
            <DropdownMenuSeparator key={i} />
          ) : (
            <DropdownMenuItem key={i} disabled={item.disabled} variant={item.destructive ? 'destructive' : undefined} onClick={item.onSelect}>
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * In the desktop app, a right click that no part of the page answered gets no webview menu (its Reload and Inspect Element are not
 * the app's). Text fields and selected text keep the native editing menu; a link gets Open link and Copy link.
 */
export function installDesktopContextMenu() {
  if (!isDesktop()) return
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    const target = e.composedPath()[0]
    const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    if (el?.closest(EDITABLE)) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim()) return
    const link = el?.closest('a[href]')
    if (link instanceof HTMLAnchorElement && /^(https?|mailto):/.test(link.href)) {
      openContextMenu(e, [
        { label: 'Open link', onSelect: () => openExternal(link.href) },
        { label: 'Copy link', onSelect: () => copyText(link.href, 'Link copied') },
      ])
      return
    }
    e.preventDefault()
  })
}
