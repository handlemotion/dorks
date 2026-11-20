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
      <SettingsSection title="Account">
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
            description="Fine-grained"
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
              Read and write on contents, pull requests, issues and workflows.{' '}
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                Create one
              </a>
            </p>
          </SettingsGroupBody>
        </SettingsGroup>
        {isDesktop() && (
          <SettingsGroup>
            <SettingsButtonRow
              label="GitHub CLI login"
              description="Reaches all your repositories. A scoped token is safer."
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
