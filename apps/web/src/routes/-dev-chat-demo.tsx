import { useState } from 'react'
import { draftChangesOf, type Block } from '@dorks/shared'
import type { Usage } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '@dorks/ui/message-scroller'
import { FrameLayout } from '../components/AppFrame'
import { AppSidebarView } from '../components/AppSidebar'
import { UsageMenuView } from '../components/UsageMenu'
import { AgentStatus } from '../components/AgentStatus'
import { ChatMessages } from '../components/ChatBlock'
import { ChatToc } from '../components/ChatToc'
import { ChatDetails } from '../components/ChatDetails'
import { ChatSplit, ShowDetailsButton, useDetailsOpen } from '../components/chat-details/layout'
import type { ChatDetailsData } from '../components/chat-details/types'
import type { WorkspaceSource } from '../components/chat-details/Files'
import type { PullRequestPanelData } from '../components/PullRequestPanel'
import type { PullRequestView, WorkspaceTree } from '@dorks/client'
import { currentStep, latestTasks, progressStore, progressTurns, stepLabel } from '../lib/progress'
import { Composer, type AgentProvider } from '../components/ChatComposer'
import { ChatMenu } from '../components/ChatMenu'
import { ArchiveButton, PageHeader } from '../components/PageHeader'
import { withReply, type Reply } from '../lib/reply'
import demoChatShot from '../assets/demo-chat.png'

/** Static usage for the composer's usage menu, so the demo needs no live client. */
const demoUsage: Usage = {
  claude: { session: { used: 0.42, resetsAt: Date.now() + 2 * 3_600_000 }, weekly: { used: 0.18, resetsAt: Date.now() + 4 * 86_400_000 } },
  cloud: {
    usedHours: 46.7,
    includedHours: 555.56,
    periodEnd: Date.now() + 17 * 86_400_000,
    sandboxes: { used: 4, limit: 100 },
    startsHour: { used: 9, limit: 60 },
    startsDay: { used: 27, limit: 200 },
    walletDollars: 14.79,
  },
}

const demoBlocks: Block[] = [
  {
    kind: 'user',
    id: 'u1',
    text: `Fix the flaky bridge reconnect after the box wakes. Check the current tests too.\n\n![Reconnect error in the app](${demoChatShot})`,
    at: Date.now() - 36 * 60_000,
  },
  { kind: 'assistant', id: 'a0', text: 'Looking for where the bridge resumes after a wake.', streaming: false, at: Date.now() - 32 * 60_000 },
  {
    kind: 'tool',
    id: 't1',
    name: 'Bash',
    summary: "rg -n 'wake|reconnect' infra/bridge/src",
    input: { command: "rg -n 'wake|reconnect' infra/bridge/src" },
    status: 'ok',
    preview: 'infra/bridge/src/claude.ts:223: resume box\ninfra/bridge/src/claude.ts:228: reconnect bridge',
  },
  { kind: 'tool', id: 't2', name: 'Bash', summary: 'pnpm --filter @dorks/bridge test', status: 'error', preview: 'FAIL reconnect restores queued messages\nError: timed out waiting for bridge' },
  {
    kind: 'assistant',
    id: 'a0b',
    text: `The reconnect test times out. The queue flushes before the handshake, so I’ll wait for it.\n\n![The timeout](${demoChatShot})`,
    streaming: false,
    at: Date.now() - 28 * 60_000,
  },
  {
    kind: 'tool',
    id: 't2p',
    name: 'TodoWrite',
    summary: 'Plan the reconnect fix',
    status: 'ok',
    input: {
      todos: [
        { content: 'Find where the bridge resumes after a wake', status: 'completed' },
        { content: 'Reproduce the reconnect test timeout', status: 'completed' },
        { content: 'Wait for the handshake before flushing the queue', status: 'completed' },
        { content: 'Add a regression test for messages sent while waking', status: 'in_progress' },
        { content: 'Check the dispatch order after reconnect', status: 'pending' },
      ],
    },
  },
  { kind: 'tool', id: 't2a', name: 'Read', summary: 'infra/bridge/src/reconnect.ts', status: 'ok' },
  {
    kind: 'tool',
    id: 't2b',
    name: 'Edit',
    summary: 'infra/bridge/src/reconnect.ts',
    status: 'ok',
    input: {
      file_path: 'infra/bridge/src/reconnect.ts',
      old_string: 'export async function reconnect(bridge: Bridge) {\n  await box.resume()\n  queue.flush()\n}\n',
      new_string:
        'export async function reconnect(bridge: Bridge) {\n  await box.resume()\n  // Queued messages wait for the handshake, or they land in the gap.\n  await bridge.ready()\n  queue.flush()\n}\n',
    },
    preview: 'The file infra/bridge/src/reconnect.ts has been updated.',
  },
  { kind: 'tool', id: 't2c', name: 'Bash', summary: 'pnpm --filter @dorks/bridge test', status: 'ok', preview: 'PASS reconnect restores queued messages' },
  {
    kind: 'assistant',
    id: 'a1',
    final: true,
    text:
      'The box resumed before the bridge was ready, so queued messages could arrive during that gap. The reconnect now waits for the bridge handshake before it flushes the queue, and the bridge tests pass.\n\n![Before the fix](' +
      demoChatShot +
      ') ![After the fix](' +
      demoChatShot +
      ')\n\n- Wait for the bridge handshake before flushing\n- Back off between attempts, up to 30s\n\n```ts\nexport async function reconnect(bridge: Bridge) {\n  await box.resume()\n  await bridge.ready()\n  await queue.flush()\n}\n```',
    streaming: false,
    at: Date.now() - 24 * 60_000,
  },
  { kind: 'turn', id: 'tn1', outcome: 'done', finalId: 'a1', durationMs: 134_000, at: Date.now() - 3 * 60_000 },
  { kind: 'user', id: 'u2', text: 'Please cover the reconnect race with a test before changing the handler.', at: Date.now() - 20 * 60_000 },
  {
    kind: 'tool',
    id: 'tc1',
    name: 'TaskCreate',
    summary: 'Write the wake race test',
    status: 'ok',
    input: { subject: 'Write the wake race test', description: '' },
    preview: 'Task #1 created successfully: Write the wake race test',
  },
  {
    kind: 'tool',
    id: 'tc2',
    name: 'TaskCreate',
    summary: 'Run it against the old handler',
    status: 'ok',
    input: { subject: 'Run it against the old handler', description: '' },
    preview: 'Task #2 created successfully: Run it against the old handler',
  },
  {
    kind: 'tool',
    id: 'tc3',
    name: 'TaskCreate',
    summary: 'Check the dispatch order',
    status: 'ok',
    input: { subject: 'Check the dispatch order', description: '' },
    preview: 'Task #3 created successfully: Check the dispatch order',
  },
  { kind: 'tool', id: 'tu1', name: 'TaskUpdate', summary: '1', status: 'ok', input: { taskId: '1', status: 'in_progress' }, preview: 'Updated task #1 status' },
  { kind: 'tool', id: 'tw1', name: 'Write', summary: 'infra/bridge/test/wake.test.ts', status: 'ok' },
  { kind: 'tool', id: 'tu2', name: 'TaskUpdate', summary: '1', status: 'ok', input: { taskId: '1', status: 'completed' }, preview: 'Updated task #1 status' },
  { kind: 'tool', id: 'tu3', name: 'TaskUpdate', summary: '2', status: 'ok', input: { taskId: '2', status: 'in_progress' }, preview: 'Updated task #2 status' },
  { kind: 'assistant', id: 'ab1', text: 'The bridge tests need Node 24 on the machine. I’ll try it in a fresh machine first.', streaming: false, at: Date.now() - 20 * 60_000 },
  { kind: 'tool', id: 'mr1', name: 'mcp__dorks__machine_run', summary: 'trial', status: 'ok', input: { kind: 'trial' }, preview: 'Started a trial run (run-1).' },
  { kind: 'tool', id: 'ms1', name: 'mcp__dorks__machine_submit', summary: '', status: 'ok', preview: 'Submitted.' },
  {
    kind: 'build',
    id: 'b1',
    draftId: 'd1',
    buildId: 'b1',
    buildName: 'acme demo',
    note: 'Node 24 and pnpm for the bridge, a warm typecheck, and the web app as a preview service.',
    approved: true,
    at: Date.now() - 17 * 60_000,
    run: {
      id: 'run-2',
      buildId: 'b1',
      buildName: 'acme demo',
      kind: 'image',
      status: 'running',
      step: 'setup',
      error: null,
      createdAt: Date.now() - 4 * 60_000,
      startedAt: Date.now() - 4 * 60_000,
      finishedAt: null,
    },
    changes: draftChangesOf(
      {
        machineType: 'default',
        setupScript: 'set -e\ncurl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\nsudo apt-get install -y nodejs\ncorepack enable\ncd ~/work/acme/demo\npnpm install\npnpm typecheck\n',
        repos: [],
        services: [],
      },
      {
        machineType: 'large',
        setupScript:
          'set -e\ncurl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -\nsudo apt-get install -y nodejs\ncorepack enable\ncurl -Ls https://cli.doppler.com/install.sh | sudo sh\ncd ~/work/acme/demo\npnpm install --frozen-lockfile\npnpm rebuild better-sqlite3\ncp apps/dashboard/.env.example apps/dashboard/.env\npnpm db:migrate:local\npnpm typecheck\n',
        repos: [{ repo: 'acme/demo' }],
        services: [{ name: 'web', command: 'pnpm dev', port: 5173, preview: true }],
      },
      [{ name: 'DOPPLER_TOKEN', secret: true, buildTime: false, why: 'the API worker' }],
      [],
    ),
  },
  {
    kind: 'tool',
    id: 't3',
    name: 'Bash',
    summary: 'pnpm --filter @dorks/bridge test',
    status: 'running',
    input: { command: 'pnpm --filter @dorks/bridge test', description: 'Running the bridge tests' },
  },
  {
    kind: 'assistant',
    id: 'a2',
    text: 'I added a regression test for a message arriving while the box is waking. I’m checking the dispatch order now.',
    streaming: true,
    at: Date.now() - 16 * 60_000,
  },
]

const chats = [
  { id: 'preview', title: 'Fix flaky bridge reconnect after wake', repo: 'acme/demo', working: true, state: 'working' as const, prs: [{ number: 142, state: 'open' as const }] },
  {
    id: 'two',
    title: 'Add dark mode toggle',
    repo: 'acme/web',
    working: false,
    state: 'idle' as const,
    prs: [
      { number: 136, url: 'https://github.com/acme/web/pull/136', title: 'Theme tokens for dark surfaces', state: 'merged' as const },
      { number: 137, url: 'https://github.com/acme/web/pull/137', title: 'Dark mode toggle in settings', state: 'closed' as const },
      { number: 138, url: 'https://github.com/acme/web/pull/138', title: 'Dark mode toggle, take two', state: 'open' as const },
    ],
  },
  {
    id: 'three',
    title: 'Upgrade to Node 24',
    repo: 'vercel/next.js',
    working: false,
    state: 'sleeping' as const,
    prs: [
      {
        number: 227,
        url: 'https://github.com/vercel/next.js/pull/227',
        title: 'Upgrade to Node 24',
        state: 'merged' as const,
        ship: {
          status: 'watching' as const,
          stages: [
            { name: 'CI', state: 'passed' as const },
            { name: 'Release', state: 'passed' as const },
            { name: 'Desktop', state: 'running' as const },
          ],
        },
      },
    ],
  },
  { id: 'four', title: 'Document the bridge protocol', repo: 'acme/demo', working: true, state: 'working' as const, attention: true, prs: [{ number: 101, state: 'closed' as const }] },
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

const DEMO_SCREEN = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;background:#3a6ea5;position:relative;overflow:hidden">
<div style="position:absolute;inset:8% 12% 14% 10%;background:#fff;border-radius:8px;overflow:hidden"><div style="height:36px;background:#f2f2f2;display:flex;align-items:center;padding:0 12px;font:13px system-ui">localhost:3000</div>
<div style="padding:32px;font:15px system-ui">The agent's Chrome, on its own desktop.</div></div></body>`

const details: ChatDetailsData = {
  computer: {
    awake: true,
    working: true,
    used: true,
    fetchUrl: async () => `data:text/html;charset=utf-8,${encodeURIComponent(DEMO_SCREEN)}`,
    interrupt: async () => {},
  },
  pr: { url: 'https://github.com/acme/demo/pull/142', number: 142 },
  subscriptions: [
    {
      repo: 'acme/demo',
      number: 142,
      url: 'https://github.com/acme/demo/pull/142',
      title: 'Fix flaky bridge reconnect after wake',
      source: 'auto',
      status: 'active',
      ci: 'passing',
      review: 'approved',
      mergeable: true,
      ciFixAttempts: 0,
      state: 'open',
    },
    {
      repo: 'acme/demo',
      number: 143,
      url: 'https://github.com/acme/demo/pull/143',
      title: 'Show the reconnect state in the status bar',
      source: 'auto',
      status: 'active',
      ci: 'pending',
      review: 'none',
      mergeable: true,
      ciFixAttempts: 0,
      state: 'open',
      headRef: 'dorks/reconnect-status',
      baseRef: 'dorks/bridge-reconnect',
    },
    {
      repo: 'acme/demo',
      number: 144,
      url: 'https://github.com/acme/demo/pull/144',
      title: 'Retry queued frames once the socket is back',
      source: 'auto',
      status: 'active',
      ci: 'pending',
      review: 'none',
      mergeable: true,
      ciFixAttempts: 0,
      state: 'open',
      headRef: 'dorks/retry-frames',
      baseRef: 'dorks/reconnect-status',
    },
    {
      repo: 'acme/bridge',
      number: 57,
      url: 'https://github.com/acme/bridge/pull/57',
      title: 'Expose the handshake state to clients',
      source: 'agent',
      status: 'ended',
      ci: 'passing',
      review: 'approved',
      mergeable: null,
      ciFixAttempts: 0,
      state: 'merged',
    },
  ],
  previews: [
    {
      name: 'Web app',
      url: 'http://localhost:5173',
      favicon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#111"/><text x="8" y="11.5" font-family="system-ui" font-size="10" font-weight="500" fill="white" text-anchor="middle">A</text></svg>')}`,
      html: `<!doctype html><html><body style="margin:0;font:14px system-ui;color:#111">
<header style="display:flex;gap:16px;align-items:center;padding:16px 24px;border-bottom:1px solid #eee"><strong style="font-weight:500">Acme</strong><a href="#" style="color:#666">Docs</a><a href="#" style="color:#666">Pricing</a><button style="margin-left:auto;padding:6px 12px;border:0;border-radius:6px;background:#111;color:#fff">Sign in</button></header>
<main style="padding:40px 24px;max-width:520px"><h1 style="font-size:24px;font-weight:500;margin:0 0 8px">Bridge status</h1><p style="color:#666;margin:0 0 24px">Reconnects after wake: 3 today, all recovered.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div style="padding:16px;border-radius:6px;background:#f4f4f5">Queued<br><span style="font-size:20px">0</span></div><div style="padding:16px;border-radius:6px;background:#f4f4f5">Latency<br><span style="font-size:20px">42 ms</span></div></div></main></body></html>`,
    },
    {
      name: 'Docs',
      url: 'http://localhost:4321',
      favicon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#3b6be8"/><text x="8" y="11.5" font-family="system-ui" font-size="10" font-weight="500" fill="white" text-anchor="middle">D</text></svg>')}`,
    },
    {
      name: 'Storybook',
      url: 'http://localhost:6006',
      favicon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#ff4785"/><text x="8" y="11.5" font-family="system-ui" font-size="10" font-weight="500" fill="white" text-anchor="middle">S</text></svg>')}`,
    },
  ],
  changes: [
    { path: 'infra/bridge/src/claude.ts', additions: 48, deletions: 12 },
    { path: 'infra/bridge/src/reconnect.ts', additions: 112, deletions: 64, patch: RECONNECT_PATCH },
    { path: 'infra/bridge/test/reconnect.test.ts', additions: 86, deletions: 0 },
    { path: 'apps/server/src/services/dorks.ts', additions: 9, deletions: 3 },
    { path: 'docs/architecture.md', additions: 4, deletions: 1, patch: DOCS_PATCH },
  ],
  artifacts: ['wake-before.png', 'wake-after.png', 'reconnect-timeline.png', 'bridge-states.png', 'queue-flush.png'].map((name) => ({
    id: name,
    name,
    type: 'PNG',
    width: 756,
    height: 576,
    src: demoChatShot,
  })),
}

/** The PRs stacked on the demo's: #143 on its branch, #144 on #143's. */
const DEMO_STACK: Record<string, Pick<PullRequestView, 'number' | 'title' | 'headRef' | 'baseRef' | 'body'>> = {
  'https://github.com/acme/demo/pull/143': {
    number: 143,
    title: 'Show the reconnect state in the status bar',
    headRef: 'dorks/reconnect-status',
    baseRef: 'dorks/bridge-reconnect',
    body: 'Adds a reconnecting badge to the status bar while the bridge waits for its handshake.',
  },
  'https://github.com/acme/demo/pull/144': {
    number: 144,
    title: 'Retry queued frames once the socket is back',
    headRef: 'dorks/retry-frames',
    baseRef: 'dorks/reconnect-status',
    body: 'Frames queued during a reconnect are sent again once the new socket opens.',
  },
}
function useDemoStackPr(url: string): PullRequestPanelData | undefined {
  const pr = DEMO_STACK[url]
  return pr ? { view: { ...DEMO_PR, ...pr, url, state: 'open', mergeableState: 'clean', mergeable: true }, refresh: () => {}, merge: async () => {} } : undefined
}

/** The Files tab's demo: two checkouts held in memory; saves stick until the page reloads. */
const DEMO_FILES: Record<string, Map<string, string>> = {
  'acme/demo': new Map([
    ['README.md', '# demo\n\nThe reconnect demo app.\n'],
    ['package.json', '{\n  "name": "demo",\n  "private": true\n}\n'],
    ['src/bridge/reconnect.ts', 'export async function reconnect(bridge: Bridge) {\n  await box.resume()\n  await bridge.ready()\n  await queue.flush()\n}\n'],
    ['src/bridge/gate.ts', 'export class ReconnectGate {\n  private attempt: Promise<void> | null = null\n}\n'],
    ['src/app.tsx', 'export function App() {\n  return <main>Demo</main>\n}\n'],
  ]),
  'acme/docs': new Map([
    ['README.md', '# docs\n'],
    ['guides/setup.md', '# Setup\n'],
  ]),
}
const DEMO_TREES: Record<string, WorkspaceTree> = Object.fromEntries(
  Object.entries(DEMO_FILES).map(([root, files]) => [
    root,
    {
      root,
      paths: [...files.keys()],
      truncated: false,
      status:
        root === 'acme/demo'
          ? [
              { path: 'src/bridge/gate.ts', status: 'added' as const },
              { path: 'src/bridge/reconnect.ts', status: 'modified' as const },
            ]
          : [],
    },
  ]),
)
const demoSha = (s: string) => String(s.length) + ':' + s.slice(0, 8)
const DEMO_WORKSPACE: WorkspaceSource = {
  useRoots: () => ({
    data: {
      roots: [
        { id: 'acme/demo', name: 'acme/demo', branch: 'dorks/bridge-reconnect', primary: true },
        { id: 'acme/docs', name: 'acme/docs', branch: 'main', primary: false },
      ],
    },
  }),
  useTree: (root) => ({ data: DEMO_TREES[root] }),
  read: async (root, path) => {
    const contents = DEMO_FILES[root]?.get(path) ?? ''
    return { root, path, kind: 'text', contents, sha: demoSha(contents), size: contents.length }
  },
  write: async (root, path, contents) => {
    DEMO_FILES[root]?.set(path, contents)
    return { sha: demoSha(contents) }
  },
  refresh: () => {},
}

/** The demo's pull request: `?pr=dirty|behind|blocked|draft|merged` shows the other merge states. */
const DEMO_PR_STATE = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('pr')
const DEMO_PR: PullRequestView = {
  repo: 'acme/demo',
  number: 142,
  url: 'https://github.com/acme/demo/pull/142',
  title: 'Fix flaky bridge reconnect after wake',
  body: `<!-- claude-projects-attribution -->
## Problem

After the laptop wakes, the bridge sometimes reconnects twice and the second socket drops queued frames. The agent then waits for a reply that never comes.

## Approach

Reconnects go through one \`ReconnectGate\`: a wake starts at most one attempt, backs off with jitter, and flushes the queue only once the new socket is open.

## Testing

- \`pnpm test\` covers the double-wake case
- Slept and woke the desktop app five times; every turn finished`,
  state: DEMO_PR_STATE === 'merged' ? 'merged' : 'open',
  draft: DEMO_PR_STATE === 'draft',
  author: { login: 'handlemotion', avatarUrl: 'https://avatars.githubusercontent.com/handlemotion' },
  headRef: 'dorks/bridge-reconnect',
  baseRef: 'main',
  headSha: 'a'.repeat(40),
  createdAt: Date.now() - 3 * 3600_000,
  mergedAt: DEMO_PR_STATE === 'merged' ? Date.now() - 5 * 60_000 : undefined,
  mergedBy: DEMO_PR_STATE === 'merged' ? { login: 'handlemotion' } : undefined,
  mergeable: DEMO_PR_STATE !== 'dirty',
  mergeableState: (DEMO_PR_STATE === 'dirty' || DEMO_PR_STATE === 'behind' || DEMO_PR_STATE === 'blocked'
    ? DEMO_PR_STATE
    : DEMO_PR_STATE === 'draft'
      ? 'draft'
      : 'clean') as PullRequestView['mergeableState'],
  additions: 259,
  deletions: 80,
  changedFiles: 5,
  checks:
    DEMO_PR_STATE === 'blocked'
      ? {
          total: 4,
          passed: 3,
          failed: 1,
          pending: 0,
          failing: ['e2e'],
          runs: [{ name: 'e2e', outcome: 'fail', summary: '2 tests failed', url: '#' }, ...['check', 'test', 'build'].map((name) => ({ name, outcome: 'pass' as const, url: '#' }))],
        }
      : {
          total: 4,
          passed: 4,
          failed: 0,
          pending: 0,
          failing: [],
          runs: ['build', 'check', 'e2e', 'test'].map((name) => ({ name, outcome: 'pass' as const, summary: name === 'e2e' ? '42 tests passed' : undefined, url: '#' })),
        },
  mergeMethods: ['squash', 'merge', 'rebase'],
  files: [
    { path: 'infra/bridge/src/claude.ts', status: 'modified', additions: 48, deletions: 12 },
    { path: 'infra/bridge/src/reconnect.ts', status: 'modified', additions: 112, deletions: 64, patch: RECONNECT_PATCH },
    { path: 'infra/bridge/test/reconnect.test.ts', status: 'added', additions: 86, deletions: 0 },
    { path: 'apps/server/src/services/dorks.ts', status: 'modified', additions: 9, deletions: 3 },
    { path: 'docs/architecture.md', status: 'modified', additions: 4, deletions: 1, patch: DOCS_PATCH },
  ],
  comments: [
    { id: 'c1', kind: 'comment', author: { login: 'octocat' }, body: 'Does this also cover the case where the wake happens mid-turn?', url: '#', createdAt: Date.now() - 90 * 60_000 },
    {
      id: 'l1',
      kind: 'review_comment',
      author: { login: 'octocat' },
      body: 'Jitter of 0–250ms seems small for a fleet; maybe up to 1s?',
      path: 'infra/bridge/src/reconnect.ts',
      line: 42,
      url: '#',
      createdAt: Date.now() - 80 * 60_000,
    },
    {
      id: 'c2',
      kind: 'comment',
      author: { login: 'handlemotion' },
      body: 'Yes: a wake mid-turn queues the frames and the gate flushes them once. Bumped the jitter to 1s.',
      url: '#',
      createdAt: Date.now() - 40 * 60_000,
    },
    { id: 'r1', kind: 'review', author: { login: 'octocat' }, body: '', reviewState: 'APPROVED', url: '#', createdAt: Date.now() - 20 * 60_000 },
  ],
}

/** The app frame with a scripted conversation and no server: for looking at the design (dev builds only). */
/** The demo's tool calls carry no times of their own: space them a few minutes apart, oldest first, so Progress shows its "ago" column. */
const initialBlocks: Block[] = demoBlocks.map((b, i) => (b.kind === 'tool' && b.at === undefined ? { ...b, at: Date.now() - (demoBlocks.length - i) * 3 * 60_000 } : b))

export function Demo() {
  const [blocks, setBlocks] = useState(initialBlocks)
  const [text, setText] = useState('')
  const [stopped, setStopped] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [archived, setArchived] = useState(false)
  const [repo, setRepo] = useState('acme/demo')
  const [provider, setProvider] = useState<AgentProvider>('claude')
  const [detailsOpen, setDetailsOpen] = useDetailsOpen()
  const [reply, setReply] = useState<Reply>()
  const [demoPr, setDemoPr] = useState(DEMO_PR)
  const demoPullRequest: PullRequestPanelData = {
    view: demoPr,
    refresh: () => {},
    merge: async (method) => {
      await new Promise((r) => setTimeout(r, 600))
      setDemoPr((p) => ({ ...p, state: 'merged', mergedAt: Date.now(), mergedBy: p.author }))
      console.info('demo merge', method)
    },
    updateBranch: async () => setDemoPr((p) => ({ ...p, mergeableState: 'clean' })),
    markReady: async () => {
      await new Promise((r) => setTimeout(r, 600))
      setDemoPr((p) => ({ ...p, draft: false, mergeableState: 'clean' }))
    },
  }
  const demoCurrent = stopped ? {} : currentStep(blocks)
  const openSteps = (keys: string[]) => {
    progressStore.show(keys)
    setDetailsOpen(true)
  }
  const send = (message = withReply(reply, text)) => {
    const id = crypto.randomUUID()
    setReply(undefined)
    setBlocks((current) => [
      ...current,
      { kind: 'user', id, text: message, at: Date.now() - 12 * 60_000 },
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
    <FrameLayout
      sidebar={
        <AppSidebarView chats={chats.map((c) => (c.id === 'preview' ? { ...c, working: !stopped, state: stopped ? 'idle' : 'working' } : c))} chatTo="/dev/chat" orderKey="dorks.demo.chat-preview" />
      }
    >
      <ChatSplit
        details={
          detailsOpen && !showNew ? (
            <ChatDetails
              sessionId="preview"
              data={{ ...details, progress: progressTurns(blocks), tasks: latestTasks(blocks), pullRequest: demoPullRequest, usePullRequest: useDemoStackPr, workspace: DEMO_WORKSPACE }}
              onClose={() => setDetailsOpen(false)}
              onGrab={(snippet) => setText((t) => (t ? `${t}\n\n` : '') + snippet)}
              onAsk={setText}
            />
          ) : undefined
        }
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <PageHeader
            title={showNew ? 'New session' : 'Fix flaky bridge reconnect after wake'}
            titleActions={!showNew && <ArchiveButton archived={archived} onClick={() => setArchived((a) => !a)} />}
            actions={
              <>
                {!showNew && <ChatMenu prUrl="https://github.com/acme/demo/pull/142" detailsOpen={detailsOpen} onDelete={() => setShowNew(true)} />}
                {!detailsOpen && !showNew && <ShowDetailsButton onClick={() => setDetailsOpen(true)} />}
              </>
            }
          />
          {showNew ? (
            <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-4 py-8">
              <div className="space-y-2">
                <h2 className="text-lg font-medium">What should we work on?</h2>
                <p className="text-sm text-muted-foreground">Choose a repository and agent, then describe the change you want.</p>
              </div>
              <div className="-mx-4">
                <Composer
                  text={text}
                  setText={setText}
                  environment={{ builds: [], repositories: [], value: { buildId: null, repo }, onChange: (e) => setRepo(e.repo) }}
                  provider={provider}
                  setProvider={setProvider}
                  onSubmit={() => send()}
                  pending={false}
                  error=""
                />
              </div>
            </div>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col" aria-label="thread">
              <MessageScrollerProvider autoScroll defaultScrollPosition="end">
                <MessageScroller>
                  <MessageScrollerViewport aria-label="Session transcript" className="[scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden">
                    <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-6 px-10 pt-6 pb-12" data-testid="transcript">
                      <ChatMessages
                        blocks={blocks}
                        agent="Claude"
                        onOpenSteps={openSteps}
                        onReply={(quoted, draft) => {
                          setReply(quoted)
                          if (draft) setText((t) => (t.trim() ? `${t}\n\n${draft}` : draft))
                        }}
                        onReplySend={(quoted, answer) => send(withReply(quoted, answer))}
                      />
                      <div>
                        <AgentStatus
                          state={stopped ? 'idle' : 'working'}
                          live="live"
                          step={demoCurrent.tool && stepLabel(demoCurrent.tool)}
                          since={demoCurrent.since}
                          onOpen={() => openSteps(demoCurrent.tool ? [demoCurrent.tool.id] : [])}
                        />
                      </div>
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <ChatToc blocks={blocks} />
                  <MessageScrollerButton />
                </MessageScroller>
              </MessageScrollerProvider>
              <Composer
                text={text}
                setText={setText}
                repo={repo}
                provider="claude"
                onSubmit={() => send()}
                reply={reply}
                onClearReply={() => setReply(undefined)}
                pending={false}
                error=""
                usage={<UsageMenuView usage={demoUsage} provider="claude" />}
                onStop={stopped ? undefined : stop}
              />
            </section>
          )}
        </div>
      </ChatSplit>
    </FrameLayout>
  )
}
