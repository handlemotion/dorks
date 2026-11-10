import { describe, expect, it } from 'vitest'
import type { Settings } from '@dorks/client'
import { normalizeServerUrl, resolveConnection, STORAGE_TOKEN, STORAGE_URL } from './connection'
import { canCreate, firstIncomplete, isSetupComplete, stepDone } from './onboarding'

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => Object.fromEntries(m) }
}

describe('resolveConnection', () => {
  it('prefers the desktop shell, whatever is stored', () => {
    const storage = memory({ [STORAGE_URL]: 'http://other:1', [STORAGE_TOKEN]: 'stored' })
    const c = resolveConnection({ desktop: { apiUrl: 'http://127.0.0.1:4747', ownerToken: 'owner' }, storage, search: '', dev: false })
    expect(c).toEqual({ serverUrl: 'http://127.0.0.1:4747', token: 'owner', source: 'desktop' })
  })

  it('ignores a shell config that carries only a boot error', () => {
    expect(resolveConnection({ desktop: { bootError: 'port in use' }, storage: memory(), search: '', dev: false })).toBeNull()
  })

  it('falls back to what the user stored', () => {
    const storage = memory({ [STORAGE_URL]: 'http://127.0.0.1:4747', [STORAGE_TOKEN]: 't' })
    expect(resolveConnection({ storage, search: '', dev: false })).toEqual({ serverUrl: 'http://127.0.0.1:4747', token: 't', source: 'stored' })
    expect(resolveConnection({ storage: memory(), search: '', dev: false })).toBeNull()
  })

  it('accepts ?server=&token= only in dev, so a link can never plant credentials', () => {
    const search = '?server=http://127.0.0.1:4747&token=abc'
    const prod = memory()
    expect(resolveConnection({ storage: prod, search, dev: false })).toBeNull()
    expect(prod.dump()).toEqual({})
    const dev = memory()
    expect(resolveConnection({ storage: dev, search, dev: true })).toEqual({ serverUrl: 'http://127.0.0.1:4747', token: 'abc', source: 'stored' })
    expect(dev.dump()).toEqual({ [STORAGE_URL]: 'http://127.0.0.1:4747', [STORAGE_TOKEN]: 'abc' })
  })
})

describe('normalizeServerUrl', () => {
  it.each([
    ['127.0.0.1:4747', 'http://127.0.0.1:4747'],
    ['http://localhost:4747/', 'http://localhost:4747'],
    ['https://dorks.example.com/some/path', 'https://dorks.example.com'],
  ])('%s -> %s', (raw, want) => expect(normalizeServerUrl(raw)).toBe(want))

  it('rejects other schemes and junk', () => {
    expect(normalizeServerUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeServerUrl('ftp://x')).toBeNull()
    expect(normalizeServerUrl('')).toBeNull()
  })
})

const base: Settings = {
  claudeToken: false,
  boatKey: false,
  github: { configured: false, login: null },
  boatOrg: null,
  boatEnvironment: null,
  baseSnapshotId: null,
  sleepMinutes: 10,
  commentPolicy: { mode: 'all' },
  publicUrlConfigured: false,
}

describe('onboarding', () => {
  it('walks the steps in order and reports the first missing one', () => {
    expect(firstIncomplete(base)).toBe('boat')
    expect(firstIncomplete({ ...base, boatKey: true })).toBe('snapshot')
    expect(firstIncomplete({ ...base, boatKey: true, baseSnapshotId: 's' })).toBe('agents')
    expect(firstIncomplete({ ...base, boatKey: true, baseSnapshotId: 's', claudeToken: true })).toBe('github')
    expect(firstIncomplete({ ...base, boatKey: true, baseSnapshotId: 's', boatEnvironment: 'e', github: { configured: true } })).toBeNull()
  })

  it('one agent is enough, and creating needs Boat, a snapshot and GitHub (agents are checked per provider)', () => {
    expect(stepDone({ ...base, claudeToken: true }).agents).toBe(true)
    expect(stepDone({ ...base, boatEnvironment: 'e' }).agents).toBe(true)
    expect(canCreate({ ...base, boatKey: true, baseSnapshotId: 's', github: { configured: true } })).toBe(true)
    expect(isSetupComplete({ ...base, boatKey: true, baseSnapshotId: 's', github: { configured: true } })).toBe(false)
  })
})
