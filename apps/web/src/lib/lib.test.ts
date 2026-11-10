import { expect, it } from 'vitest'
import { resolveConnection, STORAGE_TOKEN, STORAGE_URL } from './connection'

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
