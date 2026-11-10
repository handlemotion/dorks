import { useState } from 'react'
import type { Block } from '@dorks/shared'
import { Button } from '@dorks/ui/button'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@dorks/ui/message-scroller'
import { FrameLayout } from '../components/AppFrame'
import { AppSidebarView } from '../components/AppSidebar'
import { AgentStatus } from '../components/AgentStatus'
import { ChatMessages } from '../components/ChatBlock'
import { ChatDetails, ChatSplit, ShowDetailsButton, useDetailsOpen, type ChatDetailsData } from '../components/ChatDetails'
import { Composer, type AgentProvider } from '../components/ChatComposer'
import { ChatMenu } from '../components/ChatMenu'
import { ArchiveButton, PageHeader } from '../components/PageHeader'

/** A mock screenshot as an SVG data URL (parentheses escaped so it can sit inside markdown image syntax). */
const mockShot = (tint: string, line: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="${tint}"/><rect x="400" y="300" width="800" height="440" rx="40" fill="#fff"/><rect x="480" y="380" width="400" height="40" rx="20" fill="${line}"/><rect x="480" y="480" width="640" height="40" rx="20" fill="#e4e4e7"/></svg>`).replace(/\(/g, '%28').replace(/\)/g, '%29')}`

const initialBlocks: Block[] = [
  { kind: 'user', id: 'u1', text: `Fix the flaky bridge reconnect after the box wakes. Check the current tests too.\n\n![Reconnect error in the app](${mockShot('#fde2e2', '#f2a1a1')})` },
  { kind: 'tool', id: 't1', name: 'Bash', summary: "rg -n 'wake|reconnect' infra/bridge/src", status: 'ok', preview: 'infra/bridge/src/claude.ts:223: resume box\ninfra/bridge/src/claude.ts:228: reconnect bridge' },
  { kind: 'tool', id: 't2', name: 'Bash', summary: 'pnpm --filter @dorks/bridge test', status: 'error', preview: 'FAIL reconnect restores queued messages\nError: timed out waiting for bridge' },
  { kind: 'assistant', id: 'a1', text: 'The box resumes before the bridge is ready. Queued messages can arrive during that gap. I’ll add a regression test for the race.\n\n![Before the fix](' + mockShot('#e3e9f3', '#a7b4c8') + ') ![After the fix](' + mockShot('#e4f3e8', '#9fcbab') + ')\n\n- Wait for the bridge handshake before flushing\n- Cover it with a test\n\n```ts\nawait bridge.ready()\n```', streaming: false },
  { kind: 'user', id: 'u2', text: 'Please cover the reconnect race with a test before changing the handler.' },
  { kind: 'tool', id: 't3', name: 'Bash', summary: 'pnpm --filter @dorks/bridge test', status: 'running' },
  { kind: 'assistant', id: 'a2', text: 'I added a regression test for a message arriving while the box is waking. I’m checking the dispatch order now.', streaming: true },
]

const chats = [
  { id: 'preview', title: 'Fix flaky bridge reconnect after wake', repo: 'acme/demo', working: true, pr: { number: 142 } },
  { id: 'two', title: 'Add dark mode toggle', repo: 'acme/web', working: false, pr: { number: 138 } },
  { id: 'three', title: 'Upgrade to Node 24', repo: 'vercel/next.js', working: false },
  { id: 'four', title: 'Document the bridge protocol', repo: 'acme/demo', working: true },
]

/** Sample `git diff` output for the Changes tab. */
const RECONNECT_PATCH = `diff --git a/infra/bridge/src/reconnect.ts b/infra/bridge/src/reconnect.ts
--- a/infra/bridge/src/reconnect.ts
+++ b/infra/bridge/src/reconnect.ts
@@ -12,14 +12,21 @@ export function createReconnector(socket: BridgeSocket, queue: Queue) {
   let attempt = 0
   let timer: ReturnType<typeof setTimeout> | undefined
 
-  socket.on('close', () => {
-    timer = setTimeout(connect, 1000)
-  })
+  socket.on('close', () => schedule())
+
+  function schedule() {
+    clearTimeout(timer)
+    const delay = Math.min(30_000, 500 * 2 ** attempt++)
+    timer = setTimeout(connect, delay)
+  }
 
   async function connect() {
     await socket.open()
-    queue.flush()
+    // Flushing before the handshake raced the server's session check after a wake.
+    await socket.ready()
+    attempt = 0
+    await queue.flush()
   }
 
   return { connect, stop: () => clearTimeout(timer) }
 }
`

const DOCS_PATCH = `diff --git a/docs/architecture.md b/docs/architecture.md
--- a/docs/architecture.md
+++ b/docs/architecture.md
@@ -41,6 +41,9 @@ The bridge keeps one socket per sandbox.
 
 ## Reconnects
 
-The bridge reconnects after one second.
+The bridge reconnects with a backoff (0.5s, doubling, at most 30s). After it
+reconnects it waits for the server's handshake before flushing the queue, so
+messages sent while the sandbox slept are delivered once.
+See \`infra/bridge/src/reconnect.ts\`.
 
 ## Sleep
`

const details: ChatDetailsData = {
  pr: { url: 'https://github.com/acme/demo/pull/142', number: 142 },
  previewUrl: 'http://localhost:5173',
  previewHtml: `<!doctype html><html><body style="margin:0;font:14px system-ui;color:#111">
<header style="display:flex;gap:16px;align-items:center;padding:16px 24px;border-bottom:1px solid #eee"><strong style="font-weight:500">Acme</strong><a href="#" style="color:#666">Docs</a><a href="#" style="color:#666">Pricing</a><button style="margin-left:auto;padding:6px 12px;border:0;border-radius:6px;background:#111;color:#fff">Sign in</button></header>
<main style="padding:40px 24px;max-width:520px"><h1 style="font-size:24px;font-weight:500;margin:0 0 8px">Bridge status</h1><p style="color:#666;margin:0 0 24px">Reconnects after wake: 3 today, all recovered.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div style="padding:16px;border-radius:6px;background:#f4f4f5">Queued<br><span style="font-size:20px">0</span></div><div style="padding:16px;border-radius:6px;background:#f4f4f5">Latency<br><span style="font-size:20px">42 ms</span></div></div></main></body></html>`,
  changes: [
    { path: 'infra/bridge/src/claude.ts', additions: 48, deletions: 12 },
    { path: 'infra/bridge/src/reconnect.ts', additions: 112, deletions: 64, patch: RECONNECT_PATCH },
    { path: 'infra/bridge/test/reconnect.test.ts', additions: 86, deletions: 0 },
    { path: 'apps/server/src/services/dorks.ts', additions: 9, deletions: 3 },
    { path: 'docs/architecture.md', additions: 4, deletions: 1, patch: DOCS_PATCH },
  ],
  artifacts: ['wake-before.png', 'wake-after.png', 'reconnect-timeline.png', 'bridge-states.png', 'queue-flush.png'].map((name, i) => ({
    id: name,
    name,
    type: 'PNG',
    width: 1600,
    height: 1000,
    src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" fill="hsl(${210 + i * 24} 40% 92%)"/><rect x="40" y="30" width="80" height="44" rx="4" fill="white"/><rect x="48" y="38" width="40" height="4" rx="2" fill="hsl(${210 + i * 24} 20% 70%)"/><rect x="48" y="48" width="64" height="4" rx="2" fill="hsl(${210 + i * 24} 10% 85%)"/></svg>`)}`,
  })),
}

/** The app frame with a scripted conversation and no server: for looking at the design (dev builds only). */
export function Demo() {
  const [blocks, setBlocks] = useState(initialBlocks)
  const [text, setText] = useState('')
  const [stopped, setStopped] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [archived, setArchived] = useState(false)
  const [repo, setRepo] = useState('acme/demo')
  const [provider, setProvider] = useState<AgentProvider>('claude')
  const [detailsOpen, setDetailsOpen] = useDetailsOpen()
  const send = () => {
    const id = crypto.randomUUID()
    setBlocks((current) => [
      ...current,
      { kind: 'user', id, text },
      { kind: 'notice', id: `${id}-notice`, level: 'info', text: 'Preview only. No agent is connected.' },
    ])
    setText('')
    setShowNew(false)
  }
  const stop = () => {
    setStopped(true)
    setBlocks((current) => [...current, { kind: 'notice', id: crypto.randomUUID(), level: 'info', text: 'Preview agent stopped.' }])
  }

  return (
    <FrameLayout sidebar={<AppSidebarView chats={chats.map((c) => (c.id === 'preview' ? { ...c, working: !stopped } : c))} chatTo="/dev/chat" orderKey="dorks.demo.chat-preview" />}>
      <ChatSplit details={detailsOpen && !showNew ? <ChatDetails data={details} onClose={() => setDetailsOpen(false)} onGrab={(snippet) => setText((t) => (t ? `${t}\n\n` : '') + snippet)} onAsk={setText} /> : undefined}>
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader divider={showNew}
          title={showNew ? 'New session' : 'Fix flaky bridge reconnect after wake'}
          titleActions={!showNew && <ArchiveButton archived={archived} onClick={() => setArchived((a) => !a)} />}
          actions={<>
            {!showNew && <ChatMenu prUrl="https://github.com/acme/demo/pull/142" detailsOpen={detailsOpen} onDelete={() => setShowNew(true)} />}
            {!detailsOpen && !showNew && <ShowDetailsButton onClick={() => setDetailsOpen(true)} />}
          </>}
        />
        {showNew ? (
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-4 py-8">
            <div className="space-y-2">
              <h2 className="text-lg font-medium">What should we work on?</h2>
              <p className="text-sm text-muted-foreground">Choose a repository and agent, then describe the change you want.</p>
            </div>
            <div className="-mx-4">
              <Composer text={text} setText={setText} repo={repo} setRepo={setRepo} provider={provider} setProvider={setProvider} onSubmit={send} pending={false} error="" />
            </div>
          </div>
        ) : (
          <section className="flex min-h-0 flex-1 flex-col" aria-label="thread">
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller>
                <MessageScrollerViewport aria-label="Session transcript" className="[scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
                  <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-[30px] py-6" data-testid="transcript">
                    <ChatMessages blocks={blocks} />
                    <div className="mt-auto"><AgentStatus state={stopped ? 'idle' : 'working'} live="live" /></div>
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
            <Composer text={text} setText={setText} repo={repo} provider="claude" onSubmit={send} pending={false} error="" onStop={stopped ? undefined : stop} />
          </section>
        )}
      </div>
      </ChatSplit>
    </FrameLayout>
  )
}
