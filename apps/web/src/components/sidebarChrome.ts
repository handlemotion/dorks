/**
 * The sidebar's rows and labels. Rows are 30px with 2px between them; a hover fill (`useRowHover`) springs between rows instead of
 * each row painting its own, and the selected row keeps a quiet fill that darkens one step while the hover sits on it.
 * `sidebar-row` is what the hover measures.
 */
export const SIDEBAR_ROW = [
  'sidebar-row relative z-10 flex h-[30px] w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-[6px] px-2',
  'text-left text-sm leading-5 text-foreground/75 outline-none hover:text-foreground',
  'data-[active=true]:bg-foreground/[0.05] data-[active=true]:text-foreground aria-[current=page]:bg-foreground/[0.05] aria-[current=page]:text-foreground',
  'data-fluid-hover-active:data-[active=true]:bg-foreground/[0.08] data-fluid-hover-active:aria-[current=page]:bg-foreground/[0.08]',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
  '[&_svg]:size-3.5 [&_svg]:shrink-0',
].join(' ')

/** A group's label: 28px, the small size, muted. */
export const SIDEBAR_SECTION = 'flex h-7 min-w-0 shrink-0 items-center px-2 text-xs text-muted-foreground'

/** The sidebar's icon buttons (the collapse toggle): the app's 30px bar button with a 14px icon, filled only on hover. */
export const SIDEBAR_ICON_BUTTON =
  'size-[30px] rounded-[6px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground aria-expanded:bg-foreground/[0.05] [&_svg]:size-3.5!'
