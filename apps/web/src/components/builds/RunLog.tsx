import { useEffect, useMemo, useRef, useState } from 'react'
import { CopyIcon, SearchIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from 'cn'
import type { RunView } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'

const lineTone = (l: string) =>
  /^\s*(E:|error\b|fatal\b|npm ERR!)/i.test(l) ? 'bg-destructive/[0.07] text-destructive' : /^\s*(W:|warn(ing)?\b)/i.test(l) ? 'bg-amber-500/[0.08] text-amber-800 dark:text-amber-300' : ''

/** The run's redacted output, tailed while the run is live, following the end unless scrolled up. */
export function RunLog({ buildId, run }: { buildId: string; run: RunView }) {
  const client = useDorksClient()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const live = run.status === 'queued' || run.status === 'running'
  const box = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useEffect(() => {
    let cancelled = false
    client
      .runLog(buildId, run.id)
      .then((l) => {
        if (!cancelled) setText(l.text)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, buildId, run.id, run.logBytes, live])
  const lines = useMemo(() => (text ? text.replace(/\n$/, '').split('\n') : []), [text])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => !q || x.l.toLowerCase().includes(q))
  }, [lines, query])
  useEffect(() => {
    const el = box.current
    if (el && stuck.current && !query) el.scrollTop = el.scrollHeight
  }, [shown, query])
  return (
    <section aria-label="Output" className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b ps-4 pe-1.5">
        <span className="text-sm">Output</span>
        <span className="text-xs text-muted-foreground tabular-nums">{query ? `${shown.length} of ${lines.length} lines` : `${lines.length} lines`}</span>
        <label className="ms-auto flex h-7 w-52 items-center gap-1.5 rounded-[6px] bg-foreground/[0.04] px-2">
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="Search the output"
            placeholder="Search the output"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button size="icon-sm" variant="ghost" aria-label="Copy the output" disabled={!text} onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied the output.'))}>
          <CopyIcon />
        </Button>
      </div>
      <div
        ref={box}
        aria-label="run log"
        className="min-h-64 flex-1 overflow-auto py-2.5 font-mono text-xs leading-5"
        onScroll={(e) => {
          const el = e.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {shown.length === 0 ? (
          <p className="px-4 text-muted-foreground">{query ? 'No matches' : live ? 'Waiting for output…' : 'No output.'}</p>
        ) : (
          shown.map(({ l, n }) => (
            <div key={n} className={cn('flex pe-4', lineTone(l))}>
              <span aria-hidden className="w-12 shrink-0 pe-3.5 text-end text-muted-foreground/60 select-none">
                {n}
              </span>
              <span className="min-w-0 break-all whitespace-pre-wrap">{l}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
