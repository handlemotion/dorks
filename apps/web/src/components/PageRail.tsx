import type { ReactNode } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'
import { Input } from '@dorks/ui/input'

/**
 * A list page without a header bar (Plugins, Skills, Automations, Builds): one scrolling column, max-w-3xl, that starts with its top rail
 * (search and the page's buttons) under a 24px page title, instead of a bordered toolbar. The empty band above the rail is the window's drag region.
 */
export function RailPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="app-main min-h-0 flex-1 overflow-y-auto">
      <div data-tauri-drag-region className="h-16 shrink-0" />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-16 sm:px-6">
        <h1 className="-mb-2 px-0.5 text-2xl leading-8 font-normal! tracking-tight text-foreground">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/** The top rail: a search input filling the row, then the page's buttons. */
export function PageRail({ query, onQueryChange, placeholder, actions }: { query: string; onQueryChange: (q: string) => void; placeholder: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="h-8 border-input bg-surface pr-7 pl-8 text-sm dark:border-border dark:bg-input/50"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange('')}
            className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
