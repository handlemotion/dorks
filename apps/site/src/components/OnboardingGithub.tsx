import { useState } from "react";
import { Actions, Body, Heading, notify } from "@dorks/onboarding/frame";
import { List, Logo, Row } from "@dorks/onboarding/list";
import { LOGOS } from "@dorks/onboarding/providers";
import type { StepProps } from "#/components/Onboarding";

/**
 * Onboarding's GitHub step: install the Dorks Agents app on a GitHub account or organization and pick its repositories. GitHub's round
 * trip (install, then authorize) comes back to onboarding, which opens at the next step once the installation is linked. Skippable:
 * the app connects GitHub later too.
 */
export function ConnectGithubStep({ progress, onNext, onSkip, connect }: StepProps & { connect: (orgId: string) => Promise<void> }) {
  const org = progress.org!;
  const linked = progress.github.installations.filter((i) => !i.suspended);
  const [opening, setOpening] = useState(false);
  const open = () => {
    if (opening) return;
    setOpening(true);
    // Leaves the page for GitHub; it only stays when the relay refused.
    connect(org.id).catch((e: Error) => {
      setOpening(false);
      notify(e.message);
    });
  };
  const mark = <Logo {...LOGOS.github} />;
  return (
    <>
      <Body>
        <Heading title="Connect GitHub">Install Dorks Agents on your GitHub organization and pick the repositories {org.name}’s agents may work in. You can add more later.</Heading>
        <List>
          {linked.length ? (
            linked.map((i) => <Row key={i.id} icon={mark} name={`GitHub · ${i.account}`} connected onOpen={() => i.manageUrl && window.open(i.manageUrl, "_blank", "noopener")} />)
          ) : (
            <Row icon={mark} name="Dorks Agents on GitHub" onOpen={open} />
          )}
        </List>
      </Body>
      <Actions onClick={() => (linked.length ? void onNext() : open())} disabled={opening}>
        {linked.length ? "Continue" : opening ? "Opening GitHub…" : "Connect GitHub"}
      </Actions>
      {!linked.length && (
        <button type="button" onClick={() => onSkip()} className="-mt-4 self-center text-sm text-muted-foreground hover:text-foreground">
          Skip for now
        </button>
      )}
    </>
  );
}
