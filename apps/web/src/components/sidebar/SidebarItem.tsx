import { Link, type LinkProps } from '@tanstack/react-router'
import type { Glyph } from '../icons'
import { ROW_ACTIVE_PROPS, SidebarRowContent } from './SidebarRow'

export type SidebarItemProps = { icon: Glyph; label: string } & (
  | { to: LinkProps['to']; onClick?: never; active?: never }
  | { to?: never; onClick: () => void; active?: boolean }
)

/**
 * A navigation row: glyph + label. A link when given `to` (active while the URL is exactly that page, so it is not lit
 * alongside a selected chat on the same route), otherwise a button whose `active` the caller controls.
 */
export function SidebarItem({ icon: Icon, label, to, onClick, active }: SidebarItemProps) {
  const content = <SidebarRowContent cell={<Icon className="sidebar-row-glyph sidebar-row-glyph-page" ariaHidden />} label={label} />
  if (to) {
    return (
      <Link to={to} className="sidebar-row" activeOptions={{ exact: true }} activeProps={ROW_ACTIVE_PROPS}>
        {content}
      </Link>
    )
  }
  return (
    <button type="button" className="sidebar-row" data-active={active || undefined} onClick={onClick}>
      {content}
    </button>
  )
}
