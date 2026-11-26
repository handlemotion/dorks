import { SignIn } from "#/components/SignIn";

/** /invite/<id>: sign in, then accept the invitation <id>. */
export function Invite() {
  const id = decodeURIComponent(window.location.pathname.match(/^\/invite\/([^/]+)\/?$/)?.[1] ?? "");
  return <SignIn invitationId={id || undefined} />;
}
