import { useState } from 'react'
import { useTheme } from 'next-themes'
import type { GithubRepos, Settings } from '@dorks/client'
import { useDorksClient, useGithubRepos } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { GH_LOGIN_COMMAND, GH_ORG_ACCESS_URL, githubProblem, missingScopesText, scopeFixCommand } from '../../lib/github'
import { usePending } from '../../lib/pending'
import { AntigravitySignIn } from '../AntigravitySignIn'
import { OwnerAvatar } from '../RepoAvatar'
import { SettingsButtonRow, SettingsGroup, SettingsGroupBody, SettingsInputRow, SettingsRow, SettingsSection, SettingsSections, SettingsSelectRow, SettingsStatus, SettingsValueRow } from './kit'

// The person's own pages: how the app looks, the AI accounts the agents run on, and the GitHub account they act as. Token fields are
// write-only: the server only says whether one is stored, and the input is cleared after saving.

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const

export function AppearancePage() {
  const { theme, setTheme } = useTheme()
  const current = THEMES.find((t) => t.value === theme)?.value ?? 'system'
  return (
    <SettingsSections>
      <SettingsSection title="Theme">
        <SettingsGroup>
          <SettingsSelectRow label="Appearance" value={current} options={THEMES} onValueChange={setTheme} />
        </SettingsGroup>
      </SettingsSection>
    </SettingsSections>
  )
}

export function AgentsPage({ settings }: { settings: Settings }) {
  return (
    <SettingsSections>
      <ClaudeSection settings={settings} />
      <AntigravitySection settings={settings} />
      <CodexSection settings={settings} />
    </SettingsSections>
  )
}

function ClaudeSection({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  return (
    <SettingsSection title="Claude Code">
      <SettingsGroup
        label="claude token"
        onSubmit={() => {
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ claudeToken: token.trim() })
            setToken('')
            setSaved(true)
          })
        }}
      >
        <SettingsInputRow
          id="claude-token"
          label="Token"
          description={settings.claudeToken ? 'Saved' : 'Not set'}
          aria-label="claude token"
          type="password"
          autoComplete="off"
          placeholder={settings.claudeToken ? 'Replace the token' : 'sk-ant-oat01-…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          trailing={
            <Button type="submit" size="sm" disabled={pending || !token.trim()}>
              Save token
            </Button>
          }
        />
        <SettingsGroupBody>
          <p>
            From <code>claude setup-token</code>
          </p>
        </SettingsGroupBody>
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
    </SettingsSection>
  )
}

/** Antigravity (Google's agy CLI): one Google sign-in, kept encrypted on the server (services/antigravitySignIn.ts). */
function AntigravitySection({ settings }: { settings: Settings }) {
  return (
    <SettingsSection title="Antigravity" description="Gemini and the other models your Google AI plan includes.">
      <SettingsGroup label="antigravity sign-in">
        <SettingsGroupBody>
          <div className="flex items-center justify-between gap-3">
            <p>{settings.antigravityToken ? 'Signed in with Google' : 'Not signed in'}</p>
            <AntigravitySignIn settings={settings} signOut />
          </div>
        </SettingsGroupBody>
      </SettingsGroup>
    </SettingsSection>
  )
}

function CodexSection({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const [environment, setEnvironment] = useState(settings.boatEnvironment ?? '')
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  const current = settings.boatEnvironment
  return (
    <SettingsSection title="Codex" description="Optional. Trusted repositories only.">
      <SettingsGroup
        label="codex environment"
        onSubmit={() => {
          setSaved(false)
          void run(async () => {
            await actions.updateSettings({ boatEnvironment: environment.trim() })
            setSaved(true)
          })
        }}
      >
        <SettingsInputRow
          id="boat-environment"
          label="Boat environment"
          description={current ? 'Saved' : 'Not set'}
          aria-label="Boat environment"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          placeholder="dorks-codex"
          trailing={
            <Button type="submit" size="sm" disabled={pending || !environment.trim()}>
              Save
            </Button>
          }
        />
        <SettingsGroupBody>
          <p>
            <a href="https://docs.boat.dev/environments/access" target="_blank" rel="noreferrer">
              How to set up a Boat environment
            </a>
          </p>
        </SettingsGroupBody>
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
    </SettingsSection>
  )
}

export function GithubPage({ settings }: { settings: Settings }) {
  const { actions } = useDorksClient()
  const github = useGithubRepos()
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = usePending()
  const act = (fn: () => Promise<void>) => {
    setSaved(false)
    void run(async () => {
      await fn()
      setSaved(true)
    })
  }
  const { configured } = settings.github
  const problem = configured ? githubProblem(github) : null
  const signedInAs = !configured ? 'Not connected' : problem ? 'Not working' : (github?.login ?? settings.github.login ?? 'Checking…')
  const check = configured && (
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(actions.refreshGithub)}>
      Check again
    </Button>
  )
  return (
    <SettingsSections>
      <SettingsSection title="Account" actions={check}>
        <SettingsGroup>
          <SettingsValueRow label="Signed in as" value={signedInAs} tone={configured && !problem ? 'default' : 'muted'} valueTestId="github-status" />
          <SettingsButtonRow
            label="GitHub CLI"
            description={configured ? GH_CONNECTED : GH_CONNECT}
            actionLabel={configured ? 'Disconnect' : 'Connect'}
            variant={configured ? 'outline' : 'default'}
            disabled={pending}
            onAction={() => act(() => actions.updateSettings({ githubConnected: !configured }))}
          />
          {(problem || !configured) && (
            <SettingsGroupBody>
              <p>
                {problem && <>{problem} </>}
                To sign in, run <code>{GH_LOGIN_COMMAND}</code> in a terminal{configured ? ', then check again' : ''}.
              </p>
            </SettingsGroupBody>
          )}
        </SettingsGroup>
        <SettingsStatus saved={saved} error={error} />
      </SettingsSection>
      {configured && !problem && github && <GithubOrganizations github={github} />}
    </SettingsSections>
  )
}

const GH_CONNECT = 'Agents act as your gh login'
const GH_CONNECTED = 'Read live from gh'

/** The GitHub CLI login's organizations, how to add one it cannot see, and the scopes it lacks. */
function GithubOrganizations({ github }: { github: GithubRepos }) {
  const missing = github.auth.missingScopes
  return (
    <SettingsSection title="Organizations">
      <SettingsGroup>
        {github.orgs.map((org) => (
          <SettingsRow
            key={org}
            label={
              <span className="flex min-w-0 items-center gap-2">
                <OwnerAvatar owner={org} />
                <span className="truncate">{org}</span>
              </span>
            }
          />
        ))}
        {!github.orgs.length && <SettingsRow label="No organizations" />}
        <SettingsButtonRow
          label="Missing an organization?"
          description="Grant gh access to it on GitHub"
          actionLabel="Grant access"
          onAction={() => window.open(GH_ORG_ACCESS_URL, '_blank', 'noopener')}
        />
        {missing.length > 0 && (
          <SettingsGroupBody>
            <p>
              {missingScopesText(missing)} Run <code>{scopeFixCommand(missing)}</code>, then check again.
            </p>
          </SettingsGroupBody>
        )}
      </SettingsGroup>
    </SettingsSection>
  )
}
