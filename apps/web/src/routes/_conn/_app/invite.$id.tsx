import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { CloudInvitation } from '@dorks/client'
import { errorMessage } from '@dorks/client/react'
import { Button } from '@dorks/ui/button'
import { useCloudPlace } from '../../../components/CloudPlace'
import { EmptyState } from '../../../components/EmptyState'
import { PageHeader } from '../../../components/PageHeader'
import { usePending } from '../../../lib/pending'

// An invitation to a Dorks Cloud organization: `dorks://invite/<id>` in the email opens #/invite/<id> (the id is also the code the
// email shows, which Settings › Account takes). Join, and the app works in that organization.
export const Route = createFileRoute('/_conn/_app/invite/$id')({ component: InvitePage })

function InvitePage() {
  const { id } = Route.useParams()
  const place = useCloudPlace()
  const navigate = useNavigate()
  const [invitation, setInvitation] = useState<CloudInvitation | null>()
  const [readError, setReadError] = useState('')
  const { run, pending, error } = usePending()
  const signedIn = !!place?.cloud?.user
  useEffect(() => {
    if (!place || !signedIn) return
    let live = true
    place.home.actions.cloudInvitation(id).then(
      (i) => live && setInvitation(i),
      (e: unknown) => live && (setInvitation(null), setReadError(errorMessage(e))),
    )
    return () => void (live = false)
  }, [place?.home, signedIn, id])
  const answer = (accept: boolean) =>
    void run(async () => {
      await place!.home.actions.cloudOrgAction(accept ? 'accept-invitation' : 'reject-invitation', { invitationId: id })
      if (accept && invitation) place!.chooseOrg(invitation.organizationId)
      void navigate({ to: '/dorks', search: {} })
    })
  const body = !signedIn ? (
    <EmptyState figure="drawer" title="Sign in to accept the invitation" description="Use the email address the invitation was sent to.">
      <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/settings/$page', params: { page: 'cloud' } })}>
        Sign in
      </Button>
    </EmptyState>
  ) : invitation === undefined ? (
    <p className="text-sm text-muted-foreground">Loading…</p>
  ) : !invitation || invitation.status !== 'pending' ? (
    <EmptyState figure="drawer" title="This invitation is no longer open" description={readError || 'Ask for a new one.'} />
  ) : (
    <EmptyState figure="drawer" title={`Join ${invitation.organizationName ?? 'the organization'}`} description={`${invitation.inviterEmail ?? 'Someone'} invited you as ${invitation.role}.`}>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => answer(false)}>
        Decline
      </Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => answer(true)}>
        Join
      </Button>
    </EmptyState>
  )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Invitation" />
      <div className="app-main flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
        {body}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
