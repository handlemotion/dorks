import type { ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@dorks/ui/tooltip'

/**
 * The name of an icon-only action, shown on hover and focus. Every button that is only an icon gets one (the desktop shell's
 * webview never shows a native `title`). The child is the button itself: its props, ref and handlers stay its own.
 */
export function Tip({ label, side = 'bottom', children }: { label: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
