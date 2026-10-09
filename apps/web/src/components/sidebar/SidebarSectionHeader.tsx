import type { Glyph } from '../icons'
import { SidebarRowContent } from './SidebarRow'

/** Muted, non-interactive group title row (Ready, Drafts). */
export function SidebarSectionHeader({ icon: Icon, label }: { icon: Glyph; label: string }) {
  return (
    <div className="sidebar-row sidebar-section">
      <SidebarRowContent cell={<Icon className="sidebar-row-glyph" ariaHidden />} label={label} />
    </div>
  )
}
