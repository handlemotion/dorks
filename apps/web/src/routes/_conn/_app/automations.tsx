import { createFileRoute } from '@tanstack/react-router'
import { PreviewPage } from '../../../components/PreviewPage'

export const Route = createFileRoute('/_conn/_app/automations')({ component: Automations })

function Automations() {
  return <PreviewPage title="Automations" figure="relay" empty="No automations yet" description="Agents that run on a schedule, or when something happens in a repository, will show up here." />
}
