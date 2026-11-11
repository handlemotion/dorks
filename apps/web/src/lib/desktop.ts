/**
 * The desktop shell's contract (docs/desktop.md). Everything here is a no-op or `undefined` in a plain browser, so the same
 * build runs in the Tauri webview and in a tab.
 */
export interface RuntimeConfig {
  apiUrl?: string
  uiPort?: number
  bridgePort?: number
  publicUrl?: string | null
  ownerToken?: string
  dataDir?: string
  version?: string
  /** `kind` is `wurmhol` (this install's private tunnel) or `user-url`; `state` is `ready`, `error` or `lost` (restarting). */
  tunnel?: { kind: string; state: string; error?: string | null }
  /** The window is natively translucent (macOS vibrancy): the page must leave its backdrop transparent. */
  vibrancy?: boolean
  /** Present instead of the rest when the shell could not set the server up. */
  bootError?: string
}

interface TauriGlobal {
  core?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> }
  event?: { listen: (event: string, handler: () => void) => Promise<() => void> }
}

declare global {
  interface Window {
    __DORKS__?: RuntimeConfig
    __TAURI__?: TauriGlobal
  }
}

const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const core = window.__TAURI__?.core
  return core ? core.invoke<T>(cmd, args) : Promise.reject(new Error('not running in the desktop app'))
}

export const isDesktop = () => !!window.__TAURI__?.core

export type GhTokenResult = { ok: true; token: string } | { ok: false; reason: 'missing' | 'declined' | 'failed' }

/** Asks the user in a native dialog, then returns `gh auth token`. The caller stores it with `PUT /api/settings`. */
export async function readGhToken(): Promise<GhTokenResult> {
  try {
    const token = await invoke<string | null>('read_gh_token')
    return token ? { ok: true, token } : { ok: false, reason: 'missing' }
  } catch (e) {
    return { ok: false, reason: String(e) === 'consent_denied' ? 'declined' : 'failed' }
  }
}

/** Tells the shell whether dorks are working, so it can hold the Mac awake (a no-op outside the app). */
export function setKeepAwake(active: boolean) {
  if (isDesktop()) void invoke('set_keep_awake', { active }).catch(() => {})
}

/** Validates (https, or http for localhost), saves, and restarts the tunnel and server. Rejects with the shell's message. */
export async function setPublicUrl(url: string | null): Promise<void> {
  try {
    await invoke('set_public_url', { url })
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : 'Could not save the public URL.')
  }
}

export type WindowMode = 'onboarding' | 'app'

/**
 * Tells the shell which window chrome to show: `onboarding` hides the traffic lights, `app` shows them (a no-op outside the
 * app). Safe to call repeatedly; an older shell without the command just keeps its default chrome.
 */
export function setWindowMode(mode: WindowMode) {
  if (isDesktop()) void invoke('set_window_mode', { mode }).catch(() => {})
}

/**
 * Tells the shell which theme the app is showing, so the native window material (vibrancy) follows the app and not the OS. A no-op
 * outside the app, and when the shell predates the command: the page already lays a theme-matched tint over whatever material shows.
 */
export function setWindowTheme(theme: 'light' | 'dark') {
  if (isDesktop()) void invoke('set_window_theme', { theme }).catch(() => {})
}

/** Calls `handler` when the shell publishes a changed config (for example after the public URL changed). Returns an unsubscribe. */
export function onRuntimeConfig(handler: () => void): () => void {
  const listen = window.__TAURI__?.event?.listen
  if (!listen) return () => {}
  let off: (() => void) | undefined
  let closed = false
  void listen('dorks://runtime-config', handler).then((u) => (closed ? u() : (off = u)))
  return () => {
    closed = true
    off?.()
  }
}
