/**
 * The desktop shell's contract (docs/desktop.md). Everything here is a no-op or `undefined` in a plain browser, so the same
 * build runs in the Tauri webview and in a tab.
 */
export interface RuntimeConfig {
  apiUrl?: string
  uiPort?: number
  ownerToken?: string
  dataDir?: string
  version?: string
  /** The window is natively translucent (macOS vibrancy): the page must leave its backdrop transparent. */
  vibrancy?: boolean
  /** Present instead of the rest when the shell could not set the server up. */
  bootError?: string
}

interface TauriGlobal {
  core?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> }
  event?: { listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void> }
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

/** Opens a web page in the default browser: invokes the shell's `open_url` command directly in the desktop app (falling back to `window.open` on older shells or in a plain browser). */
export function openExternal(url: string) {
  if (isDesktop()) {
    void invoke('open_url', { url }).catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Returns the external URL to open in the OS browser for an anchor click, or null when the link should stay inside the app. */
export function externalLinkHref(rawHref: string | null, resolvedHref: string, target: string, pageOrigin: string): string | null {
  if (!rawHref || rawHref.startsWith('#')) return null
  let url: URL
  try {
    url = new URL(resolvedHref)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
  if (url.origin === pageOrigin && target !== '_blank') return null
  return url.href
}

/**
 * In the desktop app (WKWebView on macOS), single-clicking `target="_blank"` links can be dropped unless opened through the shell.
 * Intercept plain left-clicks on external anchors and hand them straight to `openExternal`; Cmd/middle-clicks still hit `on_new_window`.
 */
export function installDesktopLinkHandler() {
  if (!isDesktop()) return
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!(anchor instanceof HTMLAnchorElement)) return
    const href = externalLinkHref(anchor.getAttribute('href'), anchor.href, anchor.target, window.location.origin)
    if (!href) return
    e.preventDefault()
    openExternal(href)
  })
}

/** Tells the shell whether dorks are working, so it can hold the Mac awake (a no-op outside the app). */
/** `scheduled` is left out until the automations are known, so a slow load never removes the login item. */
export function setKeepAwake(active: boolean, scheduled?: boolean) {
  if (isDesktop()) void invoke('set_keep_awake', { active, scheduled }).catch(() => {})
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

/** Calls `handler` when the shell publishes a changed config (for example after the window chrome changed). Returns an unsubscribe. */
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

/**
 * Where the shell's in-app update stands (`updater.rs` in the desktop app). `unsupported` in a plain browser and in builds that
 * cannot update themselves (local and unsigned ones).
 */
export type UpdateStatus =
  | { state: 'unsupported' }
  | { state: 'idle'; checking: boolean }
  | { state: 'available'; version: string; notes?: string | null }
  | { state: 'downloading'; version: string; downloaded: number; total?: number | null }
  | { state: 'installing'; version: string }
  | { state: 'failed'; version: string; message: string }

const UNSUPPORTED: UpdateStatus = { state: 'unsupported' }

/** The current update status; `unsupported` outside the app and from a shell that predates updates. */
export function updateStatus(): Promise<UpdateStatus> {
  return isDesktop() ? invoke<UpdateStatus>('update_status').catch(() => UNSUPPORTED) : Promise.resolve(UNSUPPORTED)
}

/** Calls `handler` with every change of the update status. Returns an unsubscribe. */
export function onUpdateStatus(handler: (status: UpdateStatus) => void): () => void {
  const listen = window.__TAURI__?.event?.listen
  if (!listen) return () => {}
  let off: (() => void) | undefined
  let closed = false
  void listen<UpdateStatus>('dorks://update', (e) => handler(e.payload)).then((u) => (closed ? u() : (off = u)))
  return () => {
    closed = true
    off?.()
  }
}

/** Downloads and installs the offered update, then the app relaunches. Progress arrives through `onUpdateStatus`. */
export async function installUpdate(): Promise<void> {
  try {
    await invoke('install_update')
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : 'Could not install the update.')
  }
}
