import { createFileRoute } from '@tanstack/react-router'
import { PreviewPage } from '../../../components/PreviewPage'

export const Route = createFileRoute('/_conn/_app/builds')({ component: Builds })

function Builds() {
  return <PreviewPage title="Builds" figure="stack" empty="No builds yet" description="The machine snapshots your sandboxes start from will show up here, newest first." />
}
