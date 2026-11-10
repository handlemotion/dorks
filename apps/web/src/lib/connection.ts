import type { RuntimeConfig } from './desktop'

/**
 * Where the UI finds its server. The desktop shell injects `window.__DORKS__` (`apiUrl` and `ownerToken`) before the page
 * loads; a plain browser (dev, or the server opened by hand) falls back to what the user typed once, kept in localStorage.
 */
export interface Connection {
  serverUrl: string
  token: string
  /** `desktop`: managed by the shell, cannot be edited here. `stored`: typed by the user, can be changed. */
  source: 'desktop' | 'stored'
}

export const STORAGE_URL = 'dorks.serverUrl'
export const STORAGE_TOKEN = 'dorks.token'
export const DEFAULT_SERVER = 'http://127.0.0.1:4747'

export interface ResolveInput {
  desktop?: RuntimeConfig
  storage: Pick<Storage, 'getItem' | 'setItem'>
  /** `location.search`. Only honoured when `dev` is true, so a link can never plant a server and token. */
  search: string
  dev: boolean
}

export function normalizeServerUrl(raw: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** Pure: desktop shell first, then (dev only) `?server=&token=`, then what was stored. */
export function resolveConnection({ desktop, storage, search, dev }: ResolveInput): Connection | null {
  if (desktop?.apiUrl && desktop.ownerToken) return { serverUrl: desktop.apiUrl, token: desktop.ownerToken, source: 'desktop' }
  if (dev) {
    const q = new URLSearchParams(search)
    const server = q.get('server') && normalizeServerUrl(q.get('server')!)
    const token = q.get('token')
    if (server && token) {
      storage.setItem(STORAGE_URL, server)
      storage.setItem(STORAGE_TOKEN, token)
    }
  }
  const serverUrl = storage.getItem(STORAGE_URL)
  const token = storage.getItem(STORAGE_TOKEN)
  return serverUrl && token ? { serverUrl, token, source: 'stored' } : null
}

export function currentConnection(): Connection | null {
  const found = resolveConnection({ desktop: window.__DORKS__, storage: localStorage, search: location.search, dev: import.meta.env.DEV })
  if (found && import.meta.env.DEV && location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash) // keep the token out of the address bar
  return found
}

export function saveConnection(serverUrl: string, token: string) {
  localStorage.setItem(STORAGE_URL, serverUrl)
  localStorage.setItem(STORAGE_TOKEN, token)
}

export function clearConnection() {
  localStorage.removeItem(STORAGE_URL)
  localStorage.removeItem(STORAGE_TOKEN)
}
