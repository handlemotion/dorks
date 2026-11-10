/** Every row Base UI renders in a menu, links and submenu triggers included. */
export const MENU_ITEM_SELECTOR = "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']"

/** Base UI marks the row it highlights (pointer or keyboard) with this. */
export const MENU_HIGHLIGHTED_SELECTOR = "[data-highlighted]"

/** Base UI marks a submenu trigger with this while its submenu is open: it stays lit while the pointer is in the submenu. */
export const MENU_HELD_SELECTOR = "[data-popup-open]"

/** The fill a menu's fluid hover highlight takes for its lit row: a destructive row keeps its red tint. */
export function menuHighlightClassName(row: HTMLElement | null) {
  return row?.dataset.variant === "destructive" ? "bg-destructive/10 dark:bg-destructive/20" : "bg-foreground/[0.05] dark:bg-foreground/[0.08]"
}
