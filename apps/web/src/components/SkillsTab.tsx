import { useEffect, useState } from 'react'
import { BookOpenIcon, CheckIcon, PlusIcon } from 'lucide-react'
import type { SkillResolution, SkillView } from '@dorks/client'
import { useDorksClient, useSkills } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { Checkbox } from '@dorks/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dorks/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@dorks/ui/field'
import { Input } from '@dorks/ui/input'
import { usePending } from '../lib/pending'
import { EmptyState } from './EmptyState'
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSections } from './settings/kit'

// Customize, Skills (docs/skills.md): installed once from GitHub, kept by the server and given to every sandbox's ~/.claude/skills.
// The Add skill dialog takes what people actually copy: `npx skills add owner/repo --skill name`, a github.com URL, or owner/repo.

/** Popular collections: a card opens the Add skill dialog on the skills it holds. */
const POPULAR = [
  { source: 'anthropics/skills', name: 'Anthropic skills', description: 'Documents, PDFs, spreadsheets, design and testing' },
  { source: 'vercel-labs/agent-skills', name: 'Vercel agent skills', description: 'React and Next.js practices, web design review' },
]

/** The Skills tab: the installed skills (or an empty state), then popular collections. `onAdd` opens the Add skill dialog. */
export function SkillsTab({ onAdd }: { onAdd: (source?: string) => void }) {
  const skills = useSkills()
  return (
    <SettingsSections>
      {skills && skills.length === 0 ? (
        <EmptyState figure="drawer" title="No skills yet" description="Skills you add here reach every session, in each sandbox.">
          <Button variant="outline" size="sm" onClick={() => onAdd()}>
            Add skill
          </Button>
        </EmptyState>
      ) : (
        <SettingsSection title="Installed" description="Shared by every session, in each sandbox’s ~/.claude/skills.">
          <SettingsGroup label="installed skills">
            {skills?.map((s) => (
              <SkillRow key={s.name} skill={s} />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}
      <SettingsSection title="Popular">
        <ul aria-label="popular skills" className="grid gap-2 md:grid-cols-2">
          {POPULAR.map((p) => (
            <PopularCard key={p.source} {...p} installed={!!skills?.some((s) => s.source.repo === p.source)} onOpen={() => onAdd(p.source)} />
          ))}
        </ul>
      </SettingsSection>
    </SettingsSections>
  )
}

function PopularCard({ name, source, description, installed, onOpen }: { name: string; source: string; description: string; installed: boolean; onOpen: () => void }) {
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-label={`browse ${source}`}
        onClick={onOpen}
        className="group flex w-full min-w-0 items-center gap-3.5 rounded-[8px] border border-foreground/[0.06] bg-surface dark:border-transparent px-4 py-2.5 text-start outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BookOpenIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm text-foreground">{name}</span>
          <span className="truncate text-xs text-muted-foreground">{description}</span>
        </span>
        {installed ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            Added
          </span>
        ) : (
          <PlusIcon className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        )}
      </button>
    </li>
  )
}

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

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/**
 * Add skill: paste a command or repository, Find, then choose. The skills the command named (or the only one) start checked.
 * `initial` (a popular collection) is looked up straight away.
 */
export function AddSkillDialog({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const { actions } = useDorksClient()
  const skills = useSkills()
  const { run, pending, error } = usePending()
  const [source, setSource] = useState(initial ?? '')
  const [found, setFound] = useState<SkillResolution | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const find = (text: string) =>
    void run(async () => {
      const r = await actions.resolveSkills(text)
      setFound(r)
      setPicked(new Set(r.requested))
    })
  useEffect(() => {
    if (initial) find(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the collection the dialog opened on
  }, [])

  const install = () =>
    void run(async () => {
      await actions.installSkills(source.trim(), [...picked])
      onClose()
    })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex max-h-[85vh] flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (found) install()
            else if (source.trim()) find(source.trim())
          }}
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-sm font-medium">{found ? found.repo : 'Add skill'}</DialogTitle>
            <DialogDescription className="text-sm leading-5">
              {found
                ? `${found.skills.length === 1 ? 'One skill' : `${found.skills.length} skills`} at ${found.ref ?? 'the default branch'} (${found.sha.slice(0, 7)}). Every session gets the ones you choose.`
                : 'Installed once from GitHub and shared by every session. Sessions can still add their own when you ask them to.'}
            </DialogDescription>
          </DialogHeader>
          <div data-slot="dialog-body" className="min-h-0 overflow-y-auto">
            {found ? (
              <SkillChoices resolution={found} picked={picked} setPicked={setPicked} installed={new Set(skills?.map((s) => s.name))} />
            ) : (
              <Field>
                <FieldLabel htmlFor="skill-source">Install command or repository</FieldLabel>
                <Input
                  id="skill-source"
                  className="font-mono text-xs"
                  placeholder="npx skills add owner/repo --skill name"
                  autoComplete="off"
                  spellCheck={false}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  autoFocus
                />
                <FieldDescription>An npx skills add command, a GitHub URL (a folder or a SKILL.md link works too) or owner/repo.</FieldDescription>
              </Field>
            )}
            {error && (
              <p role="alert" className="mt-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            {found && (
              <Button type="button" variant="ghost" size="sm" className="sm:me-auto" disabled={pending} onClick={() => setFound(null)}>
                Back
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
            {found ? (
              <Button type="submit" size="sm" disabled={pending || !picked.size}>
                {pending ? 'Installing…' : picked.size > 1 ? `Install ${picked.size} skills` : 'Install'}
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={pending || !source.trim()}>
                {pending ? 'Finding…' : 'Find skills'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SkillChoices({ resolution: r, picked, setPicked, installed }: { resolution: SkillResolution; picked: Set<string>; setPicked: (s: Set<string>) => void; installed: Set<string> }) {
  const toggle = (name: string, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(name)
    else next.delete(name)
    setPicked(next)
  }
  const all = picked.size === r.skills.length
  return (
    <div className="flex flex-col gap-2">
      {r.skills.length > 1 && (
        <button type="button" className="self-start px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setPicked(all ? new Set() : new Set(r.skills.map((s) => s.name)))}>
          {all ? 'Select none' : 'Select all'}
        </button>
      )}
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
    </div>
  )
}
