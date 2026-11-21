import { useState } from 'react'
import type { SkillResolution, SkillView } from '@dorks/client'
import { useDorksClient, useSkills } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Checkbox } from '@dorks/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Input } from '@dorks/ui/input'
import { usePending } from '../lib/pending'
import { SettingsGroup, SettingsGroupBody, SettingsRow, SettingsSection } from './settings/kit'

// Skills in Customize (docs/skills.md): installed once from GitHub, kept by the server and given to every sandbox's ~/.claude/skills.
// The field takes what people actually copy: `npx skills add owner/repo --skill name`, a github.com URL, or owner/repo.

/** Popular collections, one click from the list of skills they hold. */
const SUGGESTED = [
  { source: 'anthropics/skills', description: 'Anthropic’s skills: documents, PDFs, spreadsheets, design, testing' },
  { source: 'vercel-labs/agent-skills', description: 'Vercel’s skills: React and Next.js practices, web design review' },
]

export function SkillsSection() {
  const skills = useSkills()
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const [source, setSource] = useState('')
  const [found, setFound] = useState<{ source: string; r: SkillResolution } | null>(null)

  /** Finds the skills a source holds; one skill installs straight away, several open the chooser. */
  const find = (text: string) =>
    void run(async () => {
      const r = await actions.resolveSkills(text)
      if (r.skills.length === 1 && !r.skills[0]!.installed) {
        await actions.installSkills(text, [r.skills[0]!.name])
        setSource('')
      } else setFound({ source: text, r })
    })

  const installed = new Set(skills?.map((s) => s.name))
  return (
    <SettingsSection title="Skills" description="Installed once and shared by every session, in each sandbox’s ~/.claude/skills.">
      <SettingsGroup label="install a skill" onSubmit={() => source.trim() && find(source.trim())}>
        <div className="flex min-w-0 items-center gap-2 py-2.5 ps-4 pe-3">
          <Input
            aria-label="skill source"
            className="min-w-0 flex-1 font-mono text-xs"
            placeholder="npx skills add owner/repo --skill name, or a GitHub URL"
            autoComplete="off"
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={pending || !source.trim()}>
            {pending ? 'Finding…' : 'Install'}
          </Button>
        </div>
        {error && (
          <SettingsGroupBody>
            <p role="alert" className="text-destructive">
              {error}
            </p>
          </SettingsGroupBody>
        )}
        {skills?.map((s) => (
          <SkillRow key={s.name} skill={s} />
        ))}
        {SUGGESTED.map((s) => (
          <SettingsRow
            key={s.source}
            label={<span className="font-mono text-xs">{s.source}</span>}
            description={s.description}
            control={
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => find(s.source)}>
                Browse
              </Button>
            }
          />
        ))}
      </SettingsGroup>
      {found && (
        <ChooseDialog
          key={found.r.sha}
          source={found.source}
          resolution={found.r}
          installed={installed}
          onClose={(done) => {
            setFound(null)
            if (done) setSource('')
          }}
        />
      )}
    </SettingsSection>
  )
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function SkillRow({ skill: s }: { skill: SkillView }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const [note, setNote] = useState('')
  return (
    <SettingsRow
      label={<span className="font-mono text-xs">{s.name}</span>}
      description={
        <span className="block truncate">
          {s.description && <span>{s.description} · </span>}
          <a href={s.url} target="_blank" rel="noreferrer" className="font-mono hover:text-foreground">
            {s.source.repo}
            {s.source.ref ? `#${s.source.ref}` : ''}
          </a>
          {note && <span> · {note}</span>}
          {error && <span className="text-destructive"> · {error}</span>}
        </span>
      }
      control={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                setNote('')
                const { updated } = await actions.updateSkill(s.name)
                setNote(updated ? 'Updated' : 'Up to date')
              })
            }
          >
            Update
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-label={`remove ${s.name}`} disabled={pending} onClick={() => void run(() => actions.deleteSkill(s.name))}>
            Remove
          </Button>
        </>
      }
    />
  )
}

/** The skills a repository holds: the ones the command named (or none) are checked; installing replaces any of the same name. */
function ChooseDialog({ source, resolution: r, installed, onClose }: { source: string; resolution: SkillResolution; installed: Set<string>; onClose: (done: boolean) => void }) {
  const { actions } = useDorksClient()
  const { run, pending, error } = usePending()
  const [picked, setPicked] = useState(() => new Set(r.requested))
  const toggle = (name: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  const all = picked.size === r.skills.length
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent>
        <form
          className="flex max-h-[85vh] flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await actions.installSkills(source, [...picked])
              onClose(true)
            })
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{r.repo}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              {r.skills.length === 1 ? 'One skill' : `${r.skills.length} skills`} at {r.ref ?? 'the default branch'} ({r.sha.slice(0, 7)}). Every session gets the ones you choose.
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="min-h-0 overflow-y-auto">
            <ul aria-label="skills" className="flex flex-col gap-1">
              {r.skills.map((s) => (
                <li key={s.name}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-[6px] px-2 py-2 hover:bg-foreground/[0.03]">
                    <Checkbox className="mt-0.5" checked={picked.has(s.name)} onCheckedChange={(on) => toggle(s.name, on)} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline gap-2 text-sm">
                        <span className="font-mono text-xs text-foreground">{s.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {kb(s.bytes)}
                          {installed.has(s.name) ? ' · installed' : ''}
                        </span>
                      </span>
                      {s.description && <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {error && (
              <p role="alert" className="mt-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            {r.skills.length > 1 && (
              <Button type="button" variant="ghost" size="sm" className="sm:me-auto" onClick={() => setPicked(all ? new Set() : new Set(r.skills.map((s) => s.name)))}>
                {all ? 'Select none' : 'Select all'}
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" disabled={pending || !picked.size}>
              {pending ? 'Installing…' : picked.size > 1 ? `Install ${picked.size} skills` : 'Install'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
