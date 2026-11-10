import { EmptyState } from './EmptyState'
import { PageHeader } from './PageHeader'

/** A page that is coming: its header, then an empty state that says what will be there. No controls until it is wired. */
export function PreviewPage({ title, figure, empty, description }: { title: string; figure: 'plug' | 'relay' | 'stack'; empty: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={title} divider={false} />
      <div className="flex min-h-0 flex-1 items-center justify-center pb-12">
        <EmptyState figure={figure} title={empty} description={description} />
      </div>
    </div>
  )
}
