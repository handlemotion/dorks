import { useState } from 'react'
import { useTheme } from 'next-themes'
import type { Settings } from '@dorks/client'
import { useDorksClient } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { isDesktop, readGhToken } from '../../lib/desktop'
import { usePending } from '../../lib/pending'
import { SettingsButtonRow, SettingsGroup, SettingsGroupBody, SettingsInputRow, SettingsSection, SettingsSections, SettingsSelectRow, SettingsStatus, SettingsValueRow } from './kit'

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
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)
  const [ghError, setGhError] = useState('')
  const { run, pending, error } = usePending()
  const save = (value: string) =>
    run(async () => {
      await actions.updateSettings({ githubToken: value })
      setToken('')
      setSaved(true)
    })
  const { configured, login } = settings.github
  return (
    <SettingsSections>
      <SettingsSection title="Account" description="Dorks acts on GitHub as whoever owns this token: it clones, pushes and opens pull requests, and watches the PRs it opened.">
        <SettingsGroup
          label="github token"
          onSubmit={() => {
            setSaved(false)
            setGhError('')
            void save(token.trim())
          }}
        >
          <SettingsValueRow label="Signed in as" value={configured ? (login ?? 'Token saved') : 'No GitHub token yet'} tone={configured ? 'default' : 'muted'} valueTestId="github-status" />
          <SettingsInputRow
            id="github-token"
            label="Personal access token"
            description="Fine-grained, limited to the repositories it should work on."
            aria-label="github token"
            type="password"
            autoComplete="off"
            placeholder={configured ? 'Replace the token' : 'github_pat_…'}
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
              Give it read and write access to contents, pull requests, issues and workflows. The token is sent to your sandbox so the agent can push.{' '}
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                Create one
              </a>
              .
            </p>
          </SettingsGroupBody>
        </SettingsGroup>
        {isDesktop() && (
          <SettingsGroup>
            <SettingsButtonRow
              label="GitHub CLI login"
              description="Its login token usually has broad access to all your repositories, and it will be sent to your cloud sandbox. A scoped token is safer."
              actionLabel="Use my GitHub CLI login"
              disabled={pending}
              onAction={() => {
                setSaved(false)
                setGhError('')
                void readGhToken().then((r) => {
                  if (r.ok) return save(r.token)
                  setGhError(
                    r.reason === 'declined'
                      ? 'Cancelled: no token was read.'
                      : r.reason === 'missing'
                        ? 'The GitHub CLI is not signed in. Run `gh auth login` in a terminal first.'
                        : 'Could not read the GitHub CLI token.',
                  )
                })
              }}
            />
          </SettingsGroup>
        )}
        <SettingsStatus saved={saved} error={error || ghError} />
      </SettingsSection>
    </SettingsSections>
  )
}
