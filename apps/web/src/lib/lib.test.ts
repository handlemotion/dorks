import { expect, it } from 'vite-plus/test'
import { resolveConnection, STORAGE_TOKEN, STORAGE_URL } from './connection'
import { externalLinkHref } from './desktop'

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
