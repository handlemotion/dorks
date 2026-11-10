import type { ReactNode } from 'react'
import { Branches, Drawer, Exploded, Laptop } from '@lucasmarkes/hairline/react'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@dorks/ui/empty'

/**
 * The empty-state figures: Hairline's isometric line drawings (`@lucasmarkes/hairline`), each an object shown holding nothing. They
 * answer the pointer, follow the app's theme on their own, and rest still under reduced motion. Add one here before using a new one.
 */
const FIGURES = { laptop: Laptop, window: Exploded, drawer: Drawer, branches: Branches }

/**
 * Every empty state in the app, top to bottom: a figure (208px, 20px above the text), one or two lines of text (a title, and a description only when it
 * helps), then, 24px below, the actions as small buttons. Built on shadcn's Empty. See "Empty states" in AGENTS.md.
 */
export function EmptyState({ figure, title, description, children }: { figure: keyof typeof FIGURES; title: string; description?: string; children?: ReactNode }) {
  const Figure = FIGURES[figure]
  return (
    <Empty className="gap-6 p-8">
      <EmptyHeader className="gap-1">
        <EmptyMedia className="mb-5 w-52 [&_svg]:pointer-events-auto">
          <Figure aria-hidden className="w-full" />
        </EmptyMedia>
        <EmptyTitle className="text-sm font-medium tracking-normal">{title}</EmptyTitle>
        {description && <EmptyDescription className="text-sm">{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent className="flex-row justify-center gap-2">{children}</EmptyContent>}
    </Empty>
  )
}
