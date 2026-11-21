import type { ReactNode } from 'react'
import { CheckIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Card, cn } from './Frame'

/**
 * A card of 48px rows, one per thing to connect (the AI and GitHub steps). A row only says what it is and whether it is connected;
 * connecting is its own action, in a dialog, so the step never changes shape. Rows are split by a hairline because they share one fill.
 */
export function List({ children }: { children: ReactNode }) {
  return (
    <Card>
      <ul className="divide-y divide-surface-line dark:divide-border">{children}</ul>
    </Card>
  )
}

interface RowProps {
  icon: ReactNode
  name: string
  /** Already set up: the row says Connected, and opening it replaces what is saved. */
  connected?: boolean
  /** Not available yet: the row is shown but cannot be opened. */
  soon?: boolean
  onOpen?: () => void
}

export function Row({ icon, name, connected, soon, onOpen }: RowProps) {
  const head = (
    <>
      <span className="flex items-center gap-3">
        <span className="flex size-4 items-center justify-center" aria-hidden>
          {icon}
        </span>
        <span className={cn(soon && 'text-muted-foreground')}>{name}</span>
      </span>
      <span className={cn('flex items-center gap-1.5 transition-colors', connected ? 'text-foreground' : 'text-muted-foreground', !soon && !connected && 'group-hover/row:text-foreground')}>
        {connected && <CheckIcon className="size-3.5" aria-hidden />}
        {soon ? 'Soon' : connected ? 'Connected' : 'Connect'}
      </span>
    </>
  )
  const rowClass = 'flex h-12 w-full items-center justify-between px-4 text-left'
  return (
    <li>
      {soon ? (
        <div className={rowClass} aria-disabled>
          {head}
        </div>
      ) : (
        <button type="button" className={cn(rowClass, 'group/row outline-none focus-visible:bg-muted')} onClick={onOpen}>
          {head}
        </button>
      )}
    </li>
  )
}

/** The dialog a row opens: what to do in one or two sentences, then a `dialog-body` with the field and a footer with the actions. */
export function ConnectDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Sizing, the white sheet, the footer band and the close button are the app's dialog style (glass.css). */}
      <DialogContent className="tracking-[-0.02em]">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-base font-medium">{title}</DialogTitle>
          <DialogDescription className="text-sm leading-5">{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** Light and dark versions of a logo that has one of each (svgl ships them as separate files). */
export function Logo({ light, dark, alt = '', className = '' }: { light: string; dark?: string; alt?: string; className?: string }) {
  if (!dark) return <img src={light} alt={alt} className={cn('size-4', className)} />
  return (
    <>
      <img src={light} alt={alt} className={cn('size-4 dark:hidden', className)} />
      <img src={dark} alt={alt} className={cn('hidden size-4 dark:block', className)} />
    </>
  )
}
