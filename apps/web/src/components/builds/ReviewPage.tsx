import { Link } from '@tanstack/react-router'
import type { BuildView } from '@dorks/client'
import { Button } from '@dorks/ui/button'
import { EmptyState } from '../EmptyState'
import { PageHeader } from '../PageHeader'
import { BuildCrumb } from './shared'
import { DraftReview } from './DraftReview'

export function ReviewPage({ build, draftId }: { build: BuildView; draftId: string }) {
  const draft = build.drafts.find((d) => d.id === draftId)
  if (!draft || (draft.status !== 'submitted' && draft.status !== 'editing'))
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader parent={<BuildCrumb build={build} />} title="Change" />
        <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
          <EmptyState figure="stack" title="This change is no longer waiting" description={draft ? `It was ${draft.status}.` : undefined}>
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/builds" search={{ build: build.id }} />}>
              Back to {build.name}
            </Button>
          </EmptyState>
        </div>
      </div>
    )
  return <DraftReview build={build} draft={draft} />
}
