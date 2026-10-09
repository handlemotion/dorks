import type { ReactNode } from 'react'
import { TruncatedText } from '../TruncatedText'

/**
 * Link `activeProps` for sidebar rows. The router decides when a row link is active (it also sets `aria-current`); this
 * surfaces it as `data-active`, the attribute the sidebar CSS styles.
 */
export const ROW_ACTIVE_PROPS = { 'data-active': true } as const

/** Cell + label (+ optional meta). Rendered inside the row element by SidebarItem / ChatLink / SidebarSectionHeader. */
export function SidebarRowContent({ cell, label, meta }: { cell: ReactNode; label: string; meta?: ReactNode }) {
  return (
    <>
      {/* The 24px leading cell: holds a 16px glyph (`sidebar-row-glyph`) or a marker. */}
      <span className="sidebar-row-cell">{cell}</span>
      <TruncatedText className="sidebar-row-label" text={label} />
      {meta}
    </>
  )
}
