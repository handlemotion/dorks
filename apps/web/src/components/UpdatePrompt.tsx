import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { installUpdate, onUpdateStatus, updateStatus, type UpdateStatus } from '../lib/desktop'

/** The desktop shell's update status, live. `unsupported` in a browser and in builds that cannot update themselves. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'unsupported' })
  useEffect(() => {
    let live = true
    const off = onUpdateStatus((s) => live && setStatus(s))
    void updateStatus().then((s) => live && setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

export function UpdatePrompt() {
  const status = useUpdateStatus()
  return <UpdatePromptView status={status} onInstall={() => void installUpdate().catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not install the update.'))} />
}

type Shown = Exclude<UpdateStatus, { state: 'unsupported' } | { state: 'idle' }>

/** What the prompt says in each state, and its progress (undefined: none, or an unknown length). */
function describe(status: Shown) {
  const name = `Dorks ${status.version}`
  switch (status.state) {
    case 'available':
      return { title: 'Update available', detail: name, action: 'Update', tooltip: status.notes ?? undefined }
    case 'downloading': {
      const percent = status.total ? Math.min(100, Math.round((status.downloaded / status.total) * 100)) : undefined
      return { title: 'Downloading update', detail: percent === undefined ? name : `${name} · ${percent}%`, bar: true, percent }
    }
    case 'installing':
      return { title: 'Installing update', detail: 'Dorks will restart', bar: true, percent: 100 }
    case 'failed':
      return { title: 'Update failed', detail: name, action: 'Try again', tooltip: status.message }
  }
}

/**
 * The sidebar's update prompt, above the usage meters: a solid brand-blue block, shown only while a newer version is published, being
 * downloaded or installed, or failed to install. Choosing Update downloads it (with a progress bar), installs it and relaunches the app.
 * Nothing shows while no update is known, in a browser, or in a build that cannot update.
 */
export function UpdatePromptView({ status, onInstall }: { status: UpdateStatus; onInstall: () => void }) {
  if (status.state === 'unsupported' || status.state === 'idle') return null
  const { title, detail, action, tooltip, bar, percent } = describe(status)
  return (
    <section aria-label="App update" aria-live="polite" title={tooltip} className="flex flex-col gap-2 rounded-[6px] bg-brand px-[11px] pt-[8px] pb-[9px] text-xs leading-4 text-brand-foreground">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{title}</span>
          <span className="truncate text-brand-foreground/80 tabular-nums">{detail}</span>
        </div>
        {action && (
          <button
            type="button"
            onClick={onInstall}
            className="h-6 shrink-0 rounded-(--control-radius) bg-brand-foreground px-2.5 font-medium text-brand outline-none transition-colors hover:bg-brand-foreground/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground"
          >
            {action}
          </button>
        )}
      </div>
      {bar && (
        <div role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 overflow-hidden rounded-[2px] bg-brand-foreground/25">
          <div
            className={`h-full rounded-[2px] bg-brand-foreground transition-[width] duration-200 ease-out ${percent === undefined ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''}`}
            style={percent === undefined ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}
    </section>
  )
}
