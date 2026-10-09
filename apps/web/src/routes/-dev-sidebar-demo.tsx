import { getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { AppShell, SIDEBAR_DEFAULT_WIDTH } from '../components/AppShell'
import { ChatSidebar, type Chat } from '../components/ChatSidebar'
import { IconPlayCircle, IconPlayground, IconPlusMedium } from '../components/icons'
import { SidebarGroup, SidebarItem } from '../components/sidebar'
import type { PrState } from '../components/sidebar'

// Dev-only sidebar showcase (see dev.sidebar.tsx). The leading "-" keeps the router from treating this file as a route.
// getRouteApi instead of importing Route avoids a cycle with the route file.
const route = getRouteApi('/dev/sidebar')

const SEED: Chat[] = [
  { id: 'c1', title: 'Intercom stamping failures triage', working: true, pr: { number: 114 } },
  { id: 'c2', title: 'Migrate session storage to Convex and drop the legacy cookie fallback', working: false, pr: { number: 112 } },
  { id: 'c3', title: 'Fix flaky bridge reconnect after the box wakes', working: true, pr: { number: 109, state: 'merged' } },
  { id: 'c4', title: 'Rate limit the install callback', working: false, pr: { number: 101, state: 'closed' } },
  { id: 'c5', title: 'Refactor the settings page into sections', working: false, pr: { number: 98 } },
  { id: 'c6', title: 'Explore dark theme tokens', working: true },
  { id: 'c7', title: 'Why does 🚀 emoji handling break titles with العربية mixed in?', working: false },
  { id: 'c8', title: 'Supercalifragilisticexpialidocious_unbroken_identifier_name_that_never_wraps', working: false },
  { id: 'c9', title: 'Untitled', working: false },
]

const PR_STATES: (PrState | 'none')[] = ['none', 'open', 'merged', 'closed']

export function Demo() {
  const { dork: selected } = route.useSearch()
  const navigate = route.useNavigate()
  const [chats, setChats] = useState<Chat[]>(SEED)
  const [width, setWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const [seq, setSeq] = useState(0)
  const [nav, setNav] = useState('automations')

  const patch = (id: string, change: Partial<Chat>) => setChats((cs) => cs.map((c) => (c.id === id ? { ...c, ...change } : c)))
  const setPr = (id: string, state: PrState | 'none') =>
    patch(id, { pr: state === 'none' ? undefined : { number: 200 + Number(id.replace(/\D/g, '')), state } })

  const addChat = () => {
    const n = seq + 1
    setSeq(n)
    const id = `n${n}`
    setChats((cs) => [{ id, title: `New session ${n}`, working: true }, ...cs])
    void navigate({ search: { dork: id } })
  }

  // A selected chat and a selected nav row are mutually exclusive, as in the app.
  const goNav = (to: string) => {
    setNav(to)
    void navigate({ search: {} })
  }
  const demoNav = (
    <SidebarGroup>
      <SidebarItem icon={IconPlusMedium} label="New session" onClick={addChat} />
      <SidebarItem icon={IconPlayCircle} label="Automations" onClick={() => goNav('automations')} active={!selected && nav === 'automations'} />
      <SidebarItem icon={IconPlayground} label="Customize" onClick={() => goNav('customize')} active={!selected && nav === 'customize'} />
    </SidebarGroup>
  )

  return (
    <AppShell
      layoutId="app-shell-demo"
      onSidebarResize={setWidth}
      sidebar={<ChatSidebar chats={chats} nav={demoNav} orderKey="dorks.demo.chat-order" chatTo="/dev/sidebar" />}
    >
      <div className="p-8">
          <div className="mx-auto flex max-w-2xl flex-col gap-8">
            <header>
              <h1 className="text-base font-medium">Sidebar demo</h1>
              <p className="mt-1 text-ink-muted">
                Mock data, no backend. Hover and click rows, drag chats to reorder within a group, drag the divider to resize ({width}px), click it to reset to {SIDEBAR_DEFAULT_WIDTH}px, and
                use the controls below to flip a chat between working and idle or change its pull request.
              </p>
            </header>

            <section className="flex flex-col gap-3">
              <h2 className="font-medium">Chats</h2>
              <ul className="flex flex-col divide-y divide-line rounded-row border">
                {chats.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <label className="flex shrink-0 items-center gap-1.5 text-ink-muted">
                      <input type="checkbox" checked={c.working} onChange={(e) => patch(c.id, { working: e.target.checked })} />
                      working
                    </label>
                    <select
                      aria-label={`Pull request for ${c.title}`}
                      className="shrink-0 rounded-cell border px-1.5 py-1"
                      value={c.pr ? (c.pr.state ?? 'open') : 'none'}
                      onChange={(e) => setPr(c.id, e.target.value as PrState | 'none')}
                    >
                      {PR_STATES.map((s) => (
                        <option key={s} value={s}>{s === 'none' ? 'no PR' : `PR ${s}`}</option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button type="button" className="rounded-row border px-3 py-1.5 hover:bg-surface-selected" onClick={addChat}>Add a working chat</button>
                <button type="button" className="rounded-row border px-3 py-1.5 hover:bg-surface-selected" onClick={() => setChats((cs) => cs.map((c) => ({ ...c, working: true })))}>All working</button>
                <button type="button" className="rounded-row border px-3 py-1.5 hover:bg-surface-selected" onClick={() => setChats((cs) => cs.map((c) => ({ ...c, working: false })))}>All idle</button>
              </div>
            </section>

            <section className="flex flex-col gap-2 text-ink-muted">
              <h2 className="font-medium text-ink">What to look at</h2>
              <ul className="list-disc pl-5">
                <li>Working chats show the orb; idle ones settle into a 4px dot. Flip a checkbox to watch it contract and expand.</li>
                <li>Rows with a pull request are under Ready, the rest under Drafts. Changing the PR menu moves a chat between them.</li>
                <li>Long titles are cut exactly where they stop fitting, and re-cut live as you resize.</li>
                <li>Row fills: hover and selected share one color; the selected chat is the one in the URL.</li>
              </ul>
            </section>
          </div>
      </div>
    </AppShell>
  )
}
