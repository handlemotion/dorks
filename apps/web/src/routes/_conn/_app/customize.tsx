import { createFileRoute } from '@tanstack/react-router'
import { PreviewPage } from '../../../components/PreviewPage'

export const Route = createFileRoute('/_conn/_app/customize')({ component: Customize })

function Customize() {
  return <PreviewPage title="Customize" figure="plug" empty="No MCP servers yet" description="Servers you add here will be available to every agent, in every sandbox." />
}
