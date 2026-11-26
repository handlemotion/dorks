import type { ReactNode } from 'react'
import { BotIcon, CloudIcon, UsersIcon, LaptopIcon, LayersIcon, ListChecksIcon, MoonIcon, ShipIcon, SmartphoneIcon, SunMoonIcon, VariableIcon } from 'lucide-react'
import type { Settings } from '@dorks/client'
import githubDark from '@dorks/onboarding/assets/providers/github-dark.svg'
import githubLight from '@dorks/onboarding/assets/providers/github-light.svg'
import { Logo } from '../onboarding/List'
import { AgentsPage, AppearancePage, GithubPage } from './PersonalPages'
import { ComputerPage } from './ComputerPage'
import { PhonePage } from './PhonePage'
import { CloudPage } from './CloudPage'
import { TeamPage } from './TeamPage'
import type { RemotePolicy } from './access'
import { BoatPage, SentryPage, SessionsPage, SetupPage, SnapshotPage, VariablesPage } from './OrganizationPages'
import { SentryMark } from '../automations/TriggerEditor'

// Every settings page, by the group it sits in in the settings sidebar. Personal: how the app looks and the accounts the agents act as.
// Dorks Cloud: your account and the organization you work in. Server: what everyone on this server shares (the Boat account, its snapshot, how sessions behave, their variables).

export const SETTINGS_PAGES = ['setup', 'appearance', 'agents', 'github', 'computer', 'phone', 'cloud', 'organization', 'boat', 'snapshot', 'sessions', 'variables', 'sentry'] as const
export type SettingsPageId = (typeof SETTINGS_PAGES)[number]

export const isSettingsPage = (page: string): page is SettingsPageId => (SETTINGS_PAGES as readonly string[]).includes(page)

export interface SettingsPageDef {
  id: SettingsPageId
  title: string
  icon: ReactNode
  body: (settings: Settings) => ReactNode
  /** What it is on another server reached through Dorks Cloud (access.tsx). */
  remote: RemotePolicy
}

function GithubMark() {
  return <Logo light={githubLight} dark={githubDark} className="size-3.5 shrink-0" />
}

/** Above the groups: where the app stands. */
export const SETUP_PAGE: SettingsPageDef = { id: 'setup', title: 'Setup', icon: <ListChecksIcon />, body: (s) => <SetupPage settings={s} />, remote: 'view' }

export const PERSONAL_PAGES: SettingsPageDef[] = [
  { id: 'appearance', title: 'Appearance', icon: <SunMoonIcon />, body: () => <AppearancePage />, remote: 'local' },
  { id: 'agents', title: 'AI accounts', icon: <BotIcon />, body: (s) => <AgentsPage settings={s} />, remote: 'edit' },
  { id: 'github', title: 'GitHub', icon: <GithubMark />, body: (s) => <GithubPage settings={s} />, remote: 'hidden' },
  { id: 'computer', title: 'Your computer', icon: <LaptopIcon />, body: (s) => <ComputerPage settings={s} />, remote: 'hidden' },
  { id: 'phone', title: 'Phone', icon: <SmartphoneIcon />, body: () => <PhonePage />, remote: 'hidden' },
]

/** Dorks Cloud: your account (and invitations to you), and the organization you work in now: its members and invitations. */
export const CLOUD_PAGES: SettingsPageDef[] = [
  { id: 'cloud', title: 'Account', icon: <CloudIcon />, body: () => <CloudPage />, remote: 'local' },
  { id: 'organization', title: 'Organization', icon: <UsersIcon />, body: () => <TeamPage />, remote: 'local' },
]

export function organizationPages(): SettingsPageDef[] {
  return [
    { id: 'boat', title: 'Boat', icon: <ShipIcon />, body: (s) => <BoatPage settings={s} />, remote: 'edit' },
    { id: 'snapshot', title: 'Base snapshot', icon: <LayersIcon />, body: (s) => <SnapshotPage settings={s} />, remote: 'view' },
    { id: 'sessions', title: 'Sessions', icon: <MoonIcon />, body: (s) => <SessionsPage settings={s} />, remote: 'edit' },
    { id: 'variables', title: 'Shared variables', icon: <VariableIcon />, body: () => <VariablesPage />, remote: 'edit' },
    { id: 'sentry', title: 'Sentry', icon: <SentryMark className="size-3.5" />, body: (s) => <SentryPage settings={s} />, remote: 'edit' },
  ]
}

export function findSettingsPage(id: SettingsPageId): SettingsPageDef {
  return [SETUP_PAGE, ...PERSONAL_PAGES, ...CLOUD_PAGES, ...organizationPages()].find((p) => p.id === id) ?? SETUP_PAGE
}

let lastPage: SettingsPageId = 'setup'

/** The page settings opened on last, so /settings reopens it. */
export const rememberSettingsPage = (page: SettingsPageId) => void (lastPage = page)
export const lastSettingsPage = () => lastPage
