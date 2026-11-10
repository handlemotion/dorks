import type { ReactNode } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CircleCheckIcon, CircleIcon } from 'lucide-react'
import { useSettings } from '@dorks/client/react'
import { Alert, AlertDescription } from '@dorks/ui/alert'
import { Button } from '@dorks/ui/button'
import { Card, CardContent, CardHeader } from '@dorks/ui/card'
import { BoatForm, ClaudeForm, CliSecrets, CodexForm, CommentPolicyForm, GithubForm, PublicUrlForm, SleepMinutes, SnapshotForm } from '../../../components/SettingsForms'
import { PageHeader } from '../../../components/PageHeader'
import { isDesktop } from '../../../lib/desktop'
import { STEPS, stepDone } from '../../../lib/onboarding'

export const Route = createFileRoute('/_conn/_app/settings')({ component: Settings })

/** One settings group: a card with a heading (an h2 inside a section, which the e2e and screen readers rely on) and its form. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <Card className="dark:bg-foreground/[0.06]">
        <CardHeader>
          <h2 className="text-base font-semibold">{title}</h2>
        </CardHeader>
        <CardContent>
          <div className="settings-group">{children}</div>
        </CardContent>
      </Card>
    </section>
  )
}

function Check({ id, done, children }: { id: string; done: boolean; children: ReactNode }) {
  return (
    <li data-testid={`check-${id}`} className="flex items-center gap-2">
      {done ? <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="done" /> : <CircleIcon className="size-4 text-muted-foreground" aria-label="not done" />}
      <span>{children}</span>
    </li>
  )
}

function Settings() {
  const settings = useSettings()
  if (!settings) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  const done = stepDone(settings)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Settings" actions={<Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/dorks" />}>Back to dorks</Button>} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-6">
          <Group title="Setup">
            <section aria-label="setup checklist" className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1.5 text-sm">
                {STEPS.map((s) => <Check key={s.id} id={s.id} done={done[s.id]}>{s.title}</Check>)}
                <Check id="tunnel" done={settings.publicUrlConfigured}>Public URL for sandboxes (the tunnel)</Check>
              </ul>
              {!settings.publicUrlConfigured && (
                <Alert role="status">
                  <AlertDescription>No public URL is configured, so sandboxes cannot reach this machine. The desktop app sets it up; when running the server by hand, set <code>DORKS_PUBLIC_URL</code>.</AlertDescription>
                </Alert>
              )}
              <p><Link to="/onboarding" className="font-medium underline underline-offset-4">Run the guided setup</Link></p>
            </section>
          </Group>
          <Group title="Boat"><BoatForm settings={settings} /></Group>
          <Group title="Base snapshot"><SnapshotForm settings={settings} /></Group>
          <Group title="Claude Code"><ClaudeForm settings={settings} /></Group>
          <Group title="GitHub"><GithubForm settings={settings} /></Group>
          {isDesktop() && <Group title="Public URL"><PublicUrlForm settings={settings} /></Group>}
          <Group title="PR comments"><CommentPolicyForm settings={settings} /></Group>
          <Group title="ChatGPT for Codex (optional)"><CodexForm settings={settings} /></Group>
          <Group title="CLI secrets"><CliSecrets /></Group>
          <Group title="Sleep after idle"><SleepMinutes current={settings.sleepMinutes} /></Group>
        </div>
      </div>
    </div>
  )
}
