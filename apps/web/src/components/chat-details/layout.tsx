import { useEffect, useState, type ReactNode } from 'react'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { PanelLeftIcon } from 'lucide-react'
import { Button } from '@dorks/ui/button'
import { PanelResizeHandle } from '@dorks/ui/panel-resize-handle'
import { ResizablePanel, ResizablePanelGroup } from '@dorks/ui/resizable'
import { BAR_BUTTON } from '../PreviewBrowser'
import { Tip } from '../Tip'

/** The hide/show buttons: 30px, like the tabs, with the tabs' hover. */
const ACTION = BAR_BUTTON

const OPEN_KEY = 'dorks.chat-details-open'

/** Whether Chat details is shown beside a chat, remembered per browser. Open by default. */
export function useDetailsOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const set = (next: boolean) => {
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    } catch {
      /* private mode: keep it in memory */
    }
  }
  return [open, set] as const
}

/**
 * The chat header's button that brings Chat details back. Wide windows only, like the panel itself. It sits exactly where the hide
 * button was (9px from the window's right edge, centred on the 24px line), so the toggle does not jump.
 */
export function ShowDetailsButton({ onClick }: { onClick: () => void }) {
  return (
    <Tip label="Show chat details">
      <Button variant="ghost" size="icon-sm" className={`-mr-[3px] hidden lg:inline-flex ${ACTION}`} aria-label="Show chat details" onClick={onClick}>
        <PanelLeftIcon className="rotate-180" />
      </Button>
    </Tip>
  )
}

/** Whether the window is wide enough for Chat details beside the chat (Tailwind's `lg`). */
export function useWide() {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * The chat and, when given and the window is wide, Chat details beside it in a resizable split (react-resizable-panels, through
 * shadcn's Resizable). The split is remembered. The divider is Chat details' own full-height hairline; the handle sits on it.
 */
const CHAT_WIDTH = 720

export function ChatSplit({ details, children }: { details?: ReactNode; children: ReactNode }) {
  const wide = useWide()
  const layout = useDefaultLayout({ id: 'dorks.chat-split.v5', storage: localStorage })
  const chat = usePanelRef()
  if (!details || !wide) return <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
  return (
    <ResizablePanelGroup
      resizeTargetMinimumSize={{ fine: 24, coarse: 37 }}
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      {/* The chat is 720px by default and keeps its width when the window resizes; Chat details takes everything else. */}
      <ResizablePanel id="chat" panelRef={chat} defaultSize={CHAT_WIDTH} minSize={360} groupResizeBehavior="preserve-pixel-size">
        <div className="flex h-full min-w-0">{children}</div>
      </ResizablePanel>
      {/* A click on the handle snaps the chat back to its default width. */}
      <PanelResizeHandle aria-label="Resize chat and details" className="w-0 bg-transparent" onReset={() => chat.current?.resize(CHAT_WIDTH)} />
      <ResizablePanel id="details" minSize={360}>
        {details}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
