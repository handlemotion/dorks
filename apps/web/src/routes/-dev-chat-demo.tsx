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
import { AppShell } from '../components/AppShell'
import { ChatMessages } from '../components/ChatBlock'
import { Composer, type AgentProvider } from '../components/ChatComposer'
import { ChatSidebar } from '../components/ChatSidebar'

const initialBlocks: Block[] = [
  { kind: 'user', id: 'u1', text: 'Fix the flaky bridge reconnect after the box wakes. Check the current tests too.' },
  { kind: 'tool', id: 't1', name: 'Bash', summary: "rg -n 'wake|reconnect' infra/bridge/src", status: 'ok', preview: 'infra/bridge/src/claude.ts:223: resume box\ninfra/bridge/src/claude.ts:228: reconnect bridge' },
  { kind: 'tool', id: 't2', name: 'Bash', summary: 'pnpm --filter @dorks/bridge test', status: 'error', preview: 'FAIL reconnect restores queued messages\nError: timed out waiting for bridge' },
  { kind: 'assistant', id: 'a1', text: 'The box resumes before the bridge is ready. Queued messages can arrive during that gap. I’ll add a regression test for the race.', streaming: false },
  { kind: 'user', id: 'u2', text: 'Please cover the reconnect race with a test before changing the handler.' },
  { kind: 'tool', id: 't3', name: 'Bash', summary: 'pnpm --filter @dorks/bridge test', status: 'running' },
  { kind: 'assistant', id: 'a2', text: 'I added a regression test for a message arriving while the box is waking. I’m checking the dispatch order now.', streaming: true },
]

export function Demo() {
  const [blocks, setBlocks] = useState(initialBlocks)
  const [text, setText] = useState('')
  const [stopped, setStopped] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [repo, setRepo] = useState('jaantonio/demo')
  const [provider, setProvider] = useState<AgentProvider>('codex')
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
    <AppShell layoutId="app-shell-chat-demo" sidebar={<ChatSidebar chats={[{ id: 'preview', title: 'Fix flaky bridge reconnect after wake', working: !stopped }]} chatTo="/dev/chat" orderKey="dorks.demo.chat-preview" />}>
      <div className="dorks-page" data-preview>
        <header className="dorks-header">
          <div><h1>{showNew ? 'New session' : 'Session'}</h1></div>
          <div className="dorks-header-actions">
            <Button variant="ghost" size="sm" onClick={() => setShowNew(!showNew)}>{showNew ? 'Back to thread' : 'New session'}</Button>
            <span className="text-muted-foreground">Mock preview · no backend</span>
          </div>
        </header>
        {showNew ? (
          <div className="dorks-empty">
            <div className="dorks-empty-body">
              <h2>What should we work on?</h2>
              <p>Choose a repository and agent, then describe the change you want.</p>
            </div>
            <Composer text={text} setText={setText} repo={repo} setRepo={setRepo} provider={provider} setProvider={setProvider} onSubmit={send} pending={false} error="" />
          </div>
        ) : (
        <section className="dorks-thread" aria-label="thread">
          <div className="dorks-thread-header">
            <div><h2>Fix flaky bridge reconnect after wake</h2><p>jaantonio/demo · <span data-testid="state">{stopped ? 'idle' : 'working'}</span></p></div>
            <Button variant="ghost" size="sm" disabled>Archive</Button>
          </div>
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller>
              <MessageScrollerViewport aria-label="Session transcript">
                <MessageScrollerContent className="dorks-transcript gap-6" data-testid="transcript">
                  <ChatMessages blocks={blocks} />
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
          <Composer text={text} setText={setText} provider="codex" onSubmit={send} pending={false} error="" onStop={stopped ? undefined : stop} />
        </section>
        )}
      </div>
    </AppShell>
  )
}
