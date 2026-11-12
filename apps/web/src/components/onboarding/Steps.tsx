import { useState, type ReactNode } from 'react'
import { useDorksClient } from '@dorks/client/react'
import type { Settings } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { DialogClose, DialogFooter } from '@dorks/ui/dialog'
import { Input } from '@dorks/ui/input'
import claudeLogo from '../../assets/providers/claude.svg'
import githubDark from '../../assets/providers/github-dark.svg'
import githubLight from '../../assets/providers/github-light.svg'
import grokDark from '../../assets/providers/grok-dark.svg'
import grokLight from '../../assets/providers/grok-light.svg'
import openaiDark from '../../assets/providers/openai-dark.svg'
import openaiLight from '../../assets/providers/openai-light.svg'
import { BoatCheckError, saveBoat } from '../../lib/boat'
import { isDesktop, readGhToken } from '../../lib/desktop'
import { WELCOMED_KEY } from '../../lib/onboarding'
import { usePending } from '../../lib/pending'
import { A, Actions, Body, Card, Heading, notify, SecretInput, StepForm, useNotifyError } from './Frame'
import { ConnectDialog, List, Logo, Row } from './List'

export interface StepProps {
  settings: Settings
  onNext: () => void
}

// Fields on these steps are 40px (lg), like the step buttons. Elsewhere in the app inputs stay at the default 36px. On the app fill a
// field is a white surface with the same hairline as the cards (white on #f2f2f2 is under 1.15:1).
const FIELD = 'h-10 border-surface-line bg-surface'

// ---- 1. Intro ------------------------------------------------------------------------------------------------------------

const POINTS = ['In the cloud, on your own Boat', 'Runs on your subscriptions', 'Nothing hosted by us', 'Keeps going until the PR merges', 'Pretty dope']

/** The Figma reference, at its numbers: a 215px card, 16px in, the list top-aligned with 14px between rows, and a window peeking in. */
export function Intro({ onNext }: StepProps) {
  return (
    <>
      <Body>
        <Heading title="Welcome to Dorks">The AI IDE built on what we learned from the best</Heading>
        <Card className="h-[215px] p-4">
          {/* The brand circle again, small, behind the list. */}
          <div aria-hidden className="pointer-events-none absolute top-[-126px] left-[-46px] h-[375px] w-[373px] rounded-full border border-brand-line" />
          <ul className="relative flex w-[216px] flex-col gap-3.5">
            {POINTS.map((point) => (
              <li key={point} className="flex h-[18px] items-center gap-3 whitespace-nowrap">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-foreground/15" />
                {point}
              </li>
            ))}
          </ul>
          {/* A window peeking in from the right, its top edge on the list's first row: the app these steps set up. */}
          <div aria-hidden className="absolute top-[16.5px] left-[264px] flex h-[228px] w-[378px] items-start gap-2 rounded-xl bg-app/75 p-3.5">
            {/* macOS's own traffic-light colours, a detail that makes it read as a window. */}
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </div>
        </Card>
      </Body>
      <Actions
        onClick={() => {
          localStorage.setItem(WELCOMED_KEY, '1')
          onNext()
        }}
      >
        Let’s go
      </Actions>
    </>
  )
}

// ---- 2. Boat ---------------------------------------------------------------------------------------------------------------

export function BoatKey({ settings, onNext }: StepProps) {
  const { actions } = useDorksClient()
  const [key, setKey] = useState('')
  const [org, setOrg] = useState(settings.boatOrg ?? '')
  // The organization field only appears when Boat asks for one (a key with several organizations), or one is already set. Boat's
  // own message, under the fields, says why.
  const [askOrg, setAskOrg] = useState(!!settings.boatOrg)
  const { run, pending, error } = usePending()
  useNotifyError(error)
  return (
    <StepForm
      onSubmit={() => {
        if (!key.trim() && !settings.boatKey) return notify('Paste your Boat API key first.')
        if (askOrg && !org.trim()) return notify('Add the organization id Boat asked for.')
        void run(async () => {
          try {
            await saveBoat(actions, key.trim(), org.trim(), settings.boatOrg)
          } catch (e) {
            if (e instanceof BoatCheckError && e.status === 'needs_org') setAskOrg(true)
            throw e
          }
          setKey('')
          onNext()
        })
      }}
    >
      <Body>
        <Heading title="Connect Boat">
          Your sandboxes run in your own Boat account, and the key stays encrypted on this Mac. <A href="https://boat.dev/dashboard?tab=api-keys">Get a key</A>
        </Heading>
        {/* One field needs no card or label: the heading says what it is. */}
        <div className="flex flex-col gap-3">
          <SecretInput
            aria-label="boat api key"
            className={FIELD}
            autoComplete="off"
            autoFocus
            placeholder={settings.boatKey ? 'A key is saved' : 'Paste your Boat API key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          {askOrg && <Input aria-label="boat organization" className={FIELD} autoComplete="off" placeholder="Organization id" value={org} onChange={(e) => setOrg(e.target.value)} />}
        </div>
      </Body>
      <Actions type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Continue'}
      </Actions>
    </StepForm>
  )
}

// ---- 3. AI -----------------------------------------------------------------------------------------------------------------

type Agent = 'claude' | 'codex'

export function AgentSignIn({ settings, onNext }: StepProps) {
  const [open, setOpen] = useState<Agent | null>(null)
  const configured = settings.claudeToken || !!settings.boatEnvironment
  const dialog = (agent: Agent) => ({ open: open === agent, onOpenChange: (o: boolean) => setOpen(o ? agent : null) })
  const close = () => setOpen(null)
  return (
    <>
      <Body>
        <Heading title="Connect your AI">Use the plans you already pay for. One is enough to start, add the rest later in Settings.</Heading>
        <List>
          <Row icon={<Logo light={claudeLogo} />} name="Claude" connected={settings.claudeToken} onOpen={() => setOpen('claude')} />
          {/* svgl pads the OpenAI mark inside its viewBox, so it is scaled to sit at the others' size. */}
          <Row icon={<Logo light={openaiLight} dark={openaiDark} className="scale-[1.3]" />} name="Codex" connected={!!settings.boatEnvironment} onOpen={() => setOpen('codex')} />
          <Row icon={<Logo light={grokLight} dark={grokDark} />} name="Grok" soon />
        </List>
      </Body>
      <Actions onClick={() => (configured ? onNext() : notify('Connect Claude or Codex first.'))}>Continue</Actions>

      <ConnectDialog
        {...dialog('claude')}
        title="Connect Claude"
        description={
          <>
            Run <code>claude setup-token</code> in a terminal and paste what it prints. It’s stored encrypted.
          </>
        }
      >
        <SaveForm label="claude token" secret placeholder={settings.claudeToken ? 'A token is saved' : 'sk-ant-oat01-…'} save={(value) => ({ claudeToken: value })} onSaved={close} />
      </ConnectDialog>
      <ConnectDialog
        {...dialog('codex')}
        title="Connect Codex"
        description={
          <>
            Codex signs in through a Boat environment. Paste its name, and only use it with repos you trust. <A href="https://docs.boat.dev/environments/access">Boat setup</A>
          </>
        }
      >
        <SaveForm label="Boat environment" placeholder="dorks-codex" initial={settings.boatEnvironment ?? ''} save={(value) => ({ boatEnvironment: value })} onSaved={close} />
      </ConnectDialog>
    </>
  )
}

type SettingsPatch = Parameters<ReturnType<typeof useDorksClient>['actions']['updateSettings']>[0]

/**
 * A dialog's field, then Cancel and Save on the dialog's footer band. The form is `contents` so its body and footer lay out as the
 * dialog's own sections. The live stream sends the saved setting back, which marks the row Connected.
 */
function SaveForm({
  label,
  placeholder,
  secret,
  initial = '',
  extra,
  save,
  onSaved,
}: {
  label: string
  placeholder: string
  secret?: boolean
  initial?: string
  extra?: ReactNode
  save: (value: string) => SettingsPatch
  onSaved: () => void
}) {
  const { actions } = useDorksClient()
  const [value, setValue] = useState(initial)
  const { run, pending, error } = usePending()
  useNotifyError(error)
  const typed = !!value.trim() && value.trim() !== initial
  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        if (!value.trim()) return notify('Paste it first.')
        if (!typed) return onSaved()
        void run(async () => {
          await actions.updateSettings(save(value.trim()))
          onSaved()
        })
      }}
    >
      <div data-slot="dialog-body" className="flex flex-col gap-3">
        {extra}
        {secret ? (
          <SecretInput aria-label={label} className="h-10" autoComplete="off" autoFocus placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <Input aria-label={label} className="h-10" autoComplete="off" autoFocus placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---- 4. GitHub -------------------------------------------------------------------------------------------------------------

const PERMISSIONS: [string, string][] = [
  ['Contents', 'Read and write'],
  ['Pull requests', 'Read and write'],
  ['Issues', 'Read and write'],
  ['Workflows', 'Read and write'],
  ['Checks', 'Read'],
  ['Commit statuses', 'Read'],
  ['Metadata', 'Read'],
]

type GitHubWay = 'cli' | 'token'

export function GitHub({ settings, onNext }: StepProps) {
  const { actions } = useDorksClient()
  const desktop = isDesktop()
  const [open, setOpen] = useState<GitHubWay | null>(null)
  const cli = usePending()
  useNotifyError(cli.error)
  const dialog = (way: GitHubWay) => ({ open: open === way, onOpenChange: (o: boolean) => setOpen(o ? way : null) })
  const useCli = () => {
    void cli.run(async () => {
      const r = await readGhToken()
      if (!r.ok) {
        notify(
          r.reason === 'declined'
            ? 'Cancelled, no token was read.'
            : r.reason === 'missing'
              ? 'The GitHub CLI isn’t signed in. Run `gh auth login` in a terminal first.'
              : 'Couldn’t read the GitHub CLI token.',
        )
        return
      }
      await actions.updateSettings({ githubToken: r.token })
      setOpen(null)
    })
  }
  const login = settings.github.login
  const mark = <Logo light={githubLight} dark={githubDark} />
  return (
    <>
      <Body>
        <Heading title="Connect GitHub">Agents clone, push and open PRs with this token, and Dorks follows those PRs for you.</Heading>
        <List>
          {desktop && <Row icon={mark} name="GitHub CLI" onOpen={() => setOpen('cli')} />}
          <Row icon={mark} name={login ? `Token for ${login}` : 'Access token'} connected={settings.github.configured} onOpen={() => setOpen('token')} />
        </List>
      </Body>
      <Actions onClick={() => (settings.github.configured ? onNext() : notify('Add a GitHub token first.'))}>Continue</Actions>

      {desktop && (
        <ConnectDialog
          {...dialog('cli')}
          title="Use your GitHub CLI login"
          description={
            <>
              Reads your <code>gh</code> login after a native prompt. It usually reaches every repo, so a scoped token is safer.
            </>
          }
        >
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button disabled={cli.pending} onClick={useCli}>
              {cli.pending ? 'Reading…' : 'Use my gh login'}
            </Button>
          </DialogFooter>
        </ConnectDialog>
      )}
      <ConnectDialog
        {...dialog('token')}
        title="Add an access token"
        description={
          <>
            A fine-grained token for the repos the agent should touch, with these permissions. <A href="https://github.com/settings/personal-access-tokens/new">Create one</A>
          </>
        }
      >
        <SaveForm
          label="github token"
          secret
          placeholder={settings.github.configured ? 'A token is saved' : 'github_pat_…'}
          save={(value) => ({ githubToken: value })}
          onSaved={() => setOpen(null)}
          extra={
            // What the token needs, as an island like the step's own lists: name and access, one row each.
            <Card>
              <ul className="flex flex-col gap-2.5 p-4">
                {PERMISSIONS.map(([name, access]) => (
                  <li key={name} className="flex h-[18px] items-center gap-3">
                    <span aria-hidden className="size-2 shrink-0 rounded-full bg-foreground/15" />
                    <span className="flex-1">{name}</span>
                    <span className="text-muted-foreground">{access}</span>
                  </li>
                ))}
              </ul>
            </Card>
          }
        />
      </ConnectDialog>
    </>
  )
}
