import { expect, it } from 'vite-plus/test'
import { resolveConnection, STORAGE_TOKEN, STORAGE_URL } from './connection'
import { externalLinkHref } from './desktop'
import { resolveTarget } from './place'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => Object.fromEntries(m) }
}

// The one security property worth a test: a link must never plant credentials outside dev.
it('accepts ?server=&token= only in dev, so a link can never plant credentials', () => {
  const search = '?server=http://127.0.0.1:4747&token=abc'
  const prod = memory()
  expect(resolveConnection({ storage: prod, search, dev: false })).toBeNull()
  expect(prod.dump()).toEqual({})
  const dev = memory()
  expect(resolveConnection({ storage: dev, search, dev: true })).toEqual({ serverUrl: 'http://127.0.0.1:4747', token: 'abc', source: 'stored' })
  expect(dev.dump()).toEqual({ [STORAGE_URL]: 'http://127.0.0.1:4747', [STORAGE_TOKEN]: 'abc' })
})

it('opens external http(s)/mailto links in the browser while keeping in-app hash and same-origin links', () => {
  const origin = 'tauri://localhost'
  expect(externalLinkHref('https://github.com/handlemotion/dorks/pull/175', 'https://github.com/handlemotion/dorks/pull/175', '_blank', origin)).toBe('https://github.com/handlemotion/dorks/pull/175')
  expect(externalLinkHref('mailto:hi@example.com', 'mailto:hi@example.com', '', origin)).toBe('mailto:hi@example.com')
  expect(externalLinkHref('#/dorks?dork=1', 'tauri://localhost/#/dorks?dork=1', '', origin)).toBeNull()
  expect(externalLinkHref('/settings', 'http://localhost:3000/settings', '', 'http://localhost:3000')).toBeNull()
  expect(externalLinkHref('/preview', 'http://localhost:3000/preview', '_blank', 'http://localhost:3000')).toBe('http://localhost:3000/preview')
  expect(externalLinkHref('javascript:alert(1)', 'javascript:alert(1)', '_blank', origin)).toBeNull()
})

// Picking an org must land on the right server: the one that decides whose data the whole app shows.
it('resolves an org to its hosted server, this Mac, its one Mac, or asks', () => {
  const mac = (id: string, online = true) => ({ id, name: id, kind: 'mac' as const, online, lastSeenAt: null })
  const org = (servers: ReturnType<typeof mac>[] | { id: string; name: string; kind: 'hosted'; online: boolean; lastSeenAt: null }[], personal = false) => ({
    id: 'o',
    name: 'O',
    slug: null,
    logo: null,
    personal,
    plan: null,
    role: 'member',
    active: false,
    servers,
  })
  const hosted = { id: 'h', name: 'h', kind: 'hosted' as const, online: true, lastSeenAt: null }
  expect(resolveTarget(org([hosted]), null)).toEqual({ kind: 'remote', server: hosted })
  expect(resolveTarget(org([mac('me'), mac('mini')], true), 'me')).toEqual({ kind: 'home' })
  expect(resolveTarget(org([mac('mini')], true), null, 'mini')).toEqual({ kind: 'remote', server: mac('mini') })
  expect(resolveTarget(org([mac('me'), mac('r')]), 'me')).toEqual({ kind: 'home' })
  expect(resolveTarget(org([mac('r')]), null)).toEqual({ kind: 'remote', server: mac('r') })
  expect(resolveTarget(org([mac('r', false)]), null)).toMatchObject({ kind: 'choose', home: false })
  expect(resolveTarget(org([mac('r'), mac('s')]), null)).toMatchObject({ kind: 'choose', machines: [mac('r'), mac('s')] })
  expect(resolveTarget(org([]), null)).toEqual({ kind: 'choose', machines: [], home: false })
  // A Teams or Cloud org without Macs runs on the Worker; one that still has a Mac stays on it until it moves.
  expect(resolveTarget({ ...org([]), plan: 'teams' }, null)).toMatchObject({ kind: 'cloud' })
  expect(resolveTarget({ ...org([mac('r')]), plan: 'cloud' }, null)).toEqual({ kind: 'remote', server: mac('r') })
})
