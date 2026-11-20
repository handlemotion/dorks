import { useState } from 'react'
import { useTheme } from 'next-themes'
import type { GithubRepos, Settings } from '@dorks/client'
import { useDorksClient, useGithubRepos } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { GH_LOGIN_COMMAND, GH_ORG_ACCESS_URL, githubProblem, missingScopesText, scopeFixCommand } from '../../lib/github'
import { usePending } from '../../lib/pending'
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
          <SettingsSelectRow label="Appearance" description="System follows your computer's light or dark mode." value={current} options={THEMES} onValueChange={setTheme} />
        </SettingsGroup>
      </SettingsSection>
    </SettingsSections>
  )
}

export function AgentsPage({ settings }: { settings: Settings }) {
  return (
    <SettingsSections>
      <ClaudeSection settings={settings} />
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
          description={settings.claudeToken ? 'A token is saved.' : 'Not set.'}
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
            Run <code>claude setup-token</code> to get one. Stored encrypted; it is never shown again. Saving a new one replaces the old.
          </p>
        </SettingsGroupBody>
      </SettingsGroup>
      <SettingsStatus saved={saved} error={error} />
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
    <SettingsSection title="ChatGPT for Codex" description="Optional. Only for your own, trusted repositories: Codex needs the sign-in on each sandbox, so code running there can read it.">
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
          description={current ? `New Codex sandboxes use ${current}.` : 'Needed before creating Codex sessions. Dorks does not store ChatGPT tokens.'}
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
            Connect ChatGPT once in Boat’s Agents &amp; Proxying page using its short code. Use a profile containing only ChatGPT, and leave Boat’s account-wide AI credentials proxy off. Create an
            environment using that profile: turn on Agents credentials, turn off Safe for third parties, GitHub, Secrets, Boat credentials, and Proxy AI credentials.{' '}
            <a href="https://docs.boat.dev/environments/access" target="_blank" rel="noreferrer">
              Boat setup instructions
            </a>
            .
          </p>
          {current && <p>Boat checks its access settings when each sandbox starts; saving does not confirm ChatGPT is connected yet.</p>}
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
      <SettingsSection title="Account" description="Dorks acts on GitHub as your GitHub CLI login: it clones, pushes and opens pull requests, and watches the PRs it opened." actions={check}>
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

const GH_CONNECT = 'Use whoever gh is signed in as, with every organization and repository it can reach. Its token is sent to your sandboxes so agents can push.'
const GH_CONNECTED = 'Read from gh each time it is needed, so gh auth login, refresh or switch take effect here right away.'

/** The GitHub CLI login's organizations, how to add one it cannot see, and the scopes it lacks. */
function GithubOrganizations({ github }: { github: GithubRepos }) {
  const missing = github.auth.missingScopes
  return (
    <SettingsSection title="Organizations" description="Every organization your GitHub CLI login belongs to. Their repositories show in the owner switcher and the repository picker.">
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
        {!github.orgs.length && <SettingsRow label="No organizations" description="Your GitHub CLI login isn’t a member of any organization it can see." />}
        <SettingsButtonRow
          label="Missing an organization?"
          description="An organization that restricts OAuth apps hides its private repositories until it grants the GitHub CLI access. Request it on GitHub, then check again."
          actionLabel="Grant access on GitHub"
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
