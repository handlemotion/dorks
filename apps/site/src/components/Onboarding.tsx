import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Actions, Body, Card, cn, FIELD, Frame, Heading, notify, SecretInput, StepForm, A } from "@dorks/onboarding/frame";
import { ConnectDialog, List, Logo, Row } from "@dorks/onboarding/list";
import { LOGOS } from "@dorks/onboarding/providers";
import { Button } from "@dorks/ui/button";
import { DialogClose, DialogFooter } from "@dorks/ui/dialog";
import { Input } from "@dorks/ui/input";
import { Toaster } from "@dorks/ui/sonner";
import { TooltipProvider } from "@dorks/ui/tooltip";
import { DorksMark } from "#/components/DorksMark";
import { authClient } from "#/lib/cloud";
import {
  appHandoffLink,
  appHandoffState,
  fetchPlans,
  firstOpenStep,
  invite,
  isPaid,
  loadProgress,
  markPassed,
  saveWorkspace,
  setSecret,
  startCheckout,
  STEPS,
  waitForPlan,
  type Plans,
  type Progress,
  type StepId,
} from "#/lib/onboarding";

/**
 * dorks.build/onboarding: a new Dorks Cloud team, step by step, with the desktop app's onboarding pieces (@dorks/onboarding) on the
 * site's white page. Signed out, it goes to /login and comes back. Each step saves to the relay, and the page opens at the first step
 * the relay says is still open, so a reload, a Stripe Checkout round trip or another browser resumes. Opened by the desktop
 * (?app=1&state=), it ends by handing this session to the app through dorks://auth.
 */
export function Onboarding() {
  const session = authClient.useSession();
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const user = session.data?.user;
  useEffect(() => {
    if (session.isPending || user) return;
    const next = window.location.pathname + window.location.search;
    window.location.replace(`/login?${new URLSearchParams({ next })}`);
  }, [session.isPending, user]);
  return (
    <TooltipProvider>
      <Toaster position="top-center" />
      {user ? <Flow params={params} email={user.email} /> : <Loading />}
    </TooltipProvider>
  );
}

type View = StepId | "done";

function Flow({ params, email }: { params: URLSearchParams; email: string }) {
  const [progress, setProgress] = useState<Progress>();
  const [view, setView] = useState<View>();
  const [confirming, setConfirming] = useState(params.get("checkout") === "success");
  const [failed, setFailed] = useState("");
  const refresh = async () => {
    const p = await loadProgress();
    setProgress(p);
    return p;
  };
  useEffect(() => {
    (async () => {
      let p = await refresh();
      // Back from Stripe: the plan turns paid once the webhook lands.
      if (params.get("checkout") && p.org) {
        const url = new URL(window.location.href);
        url.searchParams.delete("checkout");
        history.replaceState(null, "", url);
        if (params.get("checkout") === "success" && !isPaid(p.org.plan)) {
          await waitForPlan(p.org.id);
          p = await refresh();
        }
        setConfirming(false);
      }
      setView(firstOpenStep(p) ?? "done");
    })().catch((e: Error) => setFailed(e.message));
  }, [params]);

  if (failed) return <Message title="Can't open setup" sub={failed} />;
  if (!progress || !view) return <Loading label={confirming ? "Confirming your trial…" : undefined} />;
  if (view === "done") return <Done params={params} email={email} />;

  const index = STEPS.indexOf(view);
  const goto = (v: View) => setView(v);
  const next = async () => {
    const p = await refresh();
    // Forward through the list, not to the first open step: Back then Continue lands on the step after this one.
    goto(STEPS[index + 1] ?? firstOpenStep(p) ?? "done");
  };
  const skip = (to: View = STEPS[index + 1] ?? "done") => {
    if (progress.org && view !== "workspace" && view !== "plan") markPassed(progress.org.id, view);
    goto(to);
  };
  const props: StepProps = { progress, onNext: next, onSkip: skip };
  return (
    <Frame
      steps={STEPS}
      step={view}
      className="site-onboarding"
      backdrop={
        <div className="absolute inset-x-0 top-8 flex justify-center">
          <DorksMark size={24} />
        </div>
      }
      onBack={index > 0 ? () => goto(STEPS[index - 1]!) : undefined}
    >
      {view === "workspace" && <Workspace {...props} />}
      {view === "plan" && <PlanStep {...props} />}
      {view === "invite" && <Invite {...props} />}
      {view === "boat" && <Boat {...props} />}
      {view === "agents" && <Agents {...props} />}
    </Frame>
  );
}

interface StepProps {
  progress: Progress;
  onNext: () => Promise<void>;
  /** Past this step without saving anything; the workspace and plan steps skip the rest of setup. */
  onSkip: (to?: View) => void;
}

// ---- 1. Workspace -------------------------------------------------------------------------------------------------------------

function Workspace({ progress, onNext, onSkip }: StepProps) {
  const [name, setName] = useState(progress.org?.name ?? "");
  const { run, pending } = usePending();
  return (
    <StepForm
      onSubmit={() => {
        const value = name.trim();
        if (!value) return notify("Name your workspace first.");
        void run(async () => {
          await saveWorkspace(value, progress.org);
          await onNext();
        });
      }}
    >
      <Body>
        <Heading title="Name your workspace">Your team’s home on Dorks Cloud: its chats, sandboxes and automations. You can rename it later.</Heading>
        <Input aria-label="workspace name" className={FIELD} autoFocus autoComplete="organization" placeholder="Acme" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </Body>
      <Actions type="submit" disabled={pending}>
        {pending ? "Saving…" : "Continue"}
      </Actions>
      {!progress.org && <Skip onClick={() => onSkip("done")}>Skip, use Dorks on my own Mac</Skip>}
    </StepForm>
  );
}

// ---- 2. Plan ------------------------------------------------------------------------------------------------------------------

const PLAN_COPY: Record<"teams" | "cloud", { trial: string; after: (price: string) => string; points: string[] }> = {
  teams: {
    trial: "14-day free trial",
    after: (price) => `Free for 14 days, then ${price}/month.`,
    points: ["Shared chats and automations", "Up to 50 people", "Sandboxes on your own Boat key"],
  },
  cloud: {
    trial: "Free for 10 sandbox hours",
    after: (price) => `No charge until you’ve used 10 sandbox hours, then ${price}/month.`,
    points: ["Everything in Teams", "200 sandbox hours a month, 3 at once", "No Boat account needed"],
  },
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

function PlanStep({ progress, onNext, onSkip }: StepProps) {
  const org = progress.org!;
  const current = org.plan;
  const [plans, setPlans] = useState<Plans>();
  const [choice, setChoice] = useState<"teams" | "cloud">(current === "teams" ? "teams" : "cloud");
  const { run, pending } = usePending();
  const cancelled = useRef(new URLSearchParams(window.location.search).get("checkout") === "cancel");
  useEffect(() => {
    fetchPlans().then(setPlans, () => setPlans(undefined));
    if (cancelled.current) notify("Checkout was cancelled. Pick a plan to start your trial.");
  }, []);
  if (isPaid(current))
    return (
      <>
        <Body>
          <Heading title={`${org.name} is on ${plans?.plans[current].name ?? (current === "cloud" ? "Dorks Cloud" : "Dorks Teams")}`}>Change plans or billing any time in Settings.</Heading>
        </Body>
        <Actions onClick={() => void onNext()}>Continue</Actions>
      </>
    );
  return (
    <StepForm onSubmit={() => void run(() => startCheckout(org.id, choice))}>
      <Body>
        <Heading title="Start your free trial">Pick a plan for {org.name}. Both take a card and charge nothing today. Cancel any time.</Heading>
        <div role="radiogroup" aria-label="plan" className="grid grid-cols-2 gap-3">
          {(["teams", "cloud"] as const).map((id) => {
            const plan = plans?.plans[id];
            const price = plan ? dollars(plan.monthlyCents) : id === "teams" ? "$5" : "$29";
            const copy = PLAN_COPY[id];
            const selected = choice === id;
            return (
              <Card
                key={id}
                role="radio"
                aria-checked={selected}
                tabIndex={0}
                onClick={() => setChoice(id)}
                onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), setChoice(id))}
                className={cn("flex cursor-pointer flex-col gap-4 p-4 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30", selected && "border-brand dark:border-brand")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{plan?.name ?? (id === "teams" ? "Dorks Teams" : "Dorks Cloud")}</span>
                    <span className="text-muted-foreground">
                      <span className="text-foreground">{price}</span>/month
                    </span>
                  </div>
                  <span
                    aria-hidden
                    className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-brand bg-brand text-brand-foreground" : "border-foreground/20")}
                  >
                    {selected && <CheckIcon className="size-3" strokeWidth={3} />}
                  </span>
                </div>
                <span className="w-fit rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand">{copy.trial}</span>
                <ul className="flex flex-col gap-2 text-muted-foreground">
                  {copy.points.map((p) => (
                    <li key={p} className="flex gap-2">
                      <CheckIcon className="mt-px size-3.5 shrink-0 text-foreground" aria-hidden />
                      {p}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
        <p className="text-center text-xs text-muted-foreground">{PLAN_COPY[choice].after(plans ? dollars(plans.plans[choice].monthlyCents) : choice === "teams" ? "$5" : "$29")}</p>
      </Body>
      <Actions type="submit" disabled={pending}>
        {pending ? "Opening Checkout…" : "Start free trial"}
      </Actions>
      <Skip onClick={() => onSkip("done")}>Not now</Skip>
    </StepForm>
  );
}

// ---- 3. Invite ----------------------------------------------------------------------------------------------------------------

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function Invite({ progress, onNext, onSkip }: StepProps) {
  const org = progress.org!;
  const [text, setText] = useState("");
  const { run, pending } = usePending();
  const invited = progress.invitations.map((i) => i.email);
  return (
    <StepForm
      onSubmit={() => {
        const emails = [
          ...new Set(
            text
              .split(/[\s,;]+/)
              .map((e) => e.trim().toLowerCase())
              .filter(Boolean),
          ),
        ].filter((e) => !invited.includes(e));
        if (!emails.length) return invited.length ? void onNext() : notify("Add an email address, or skip this step.");
        const wrong = emails.find((e) => !EMAIL.test(e));
        if (wrong) return notify(`${wrong} isn’t an email address.`);
        void run(async () => {
          for (const e of emails) await invite(org.id, e);
          await onNext();
        });
      }}
    >
      <Body>
        <Heading title="Invite your team">They get an email with a link to join {org.name}. You can invite more people later.</Heading>
        <div className="flex flex-col gap-3">
          <Input
            aria-label="email addresses"
            className={FIELD}
            autoFocus
            type="text"
            inputMode="email"
            autoComplete="off"
            placeholder="ada@example.com, grace@example.com"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {invited.length > 0 && (
            <List>
              {invited.map((e) => (
                <li key={e} className="flex h-12 items-center justify-between px-4">
                  <span className="truncate">{e}</span>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <CheckIcon className="size-3.5" aria-hidden />
                    Invited
                  </span>
                </li>
              ))}
            </List>
          )}
        </div>
      </Body>
      <Actions type="submit" disabled={pending}>
        {pending ? "Sending…" : text.trim() ? "Send invites" : "Continue"}
      </Actions>
      {!invited.length && <Skip onClick={() => onSkip()}>Skip for now</Skip>}
    </StepForm>
  );
}

// ---- 4. Boat ------------------------------------------------------------------------------------------------------------------

function Boat({ progress, onNext, onSkip }: StepProps) {
  const org = progress.org!;
  const saved = progress.secrets.includes("BOAT_API_KEY");
  const [key, setKey] = useState("");
  const [boatOrg, setBoatOrg] = useState("");
  const [askOrg, setAskOrg] = useState(progress.secrets.includes("BOAT_ORG"));
  const { run, pending } = usePending();
  if (org.plan === "cloud")
    return (
      <>
        <Body>
          <Heading title="Sandboxes are included">Dorks Cloud runs your team’s sandboxes on Dorks’ own Boat account. There’s nothing to connect.</Heading>
          <List>
            <li className="flex h-12 items-center justify-between px-4">
              <span>Dorks Cloud sandboxes</span>
              <span className="flex items-center gap-1.5">
                <CheckIcon className="size-3.5" aria-hidden />
                Included
              </span>
            </li>
          </List>
        </Body>
        <Actions onClick={() => onSkip()}>Continue</Actions>
      </>
    );
  return (
    <StepForm
      onSubmit={() => {
        if (!key.trim()) return saved ? void onNext() : notify("Paste your Boat API key first.");
        void run(async () => {
          await setSecret(org.id, "BOAT_API_KEY", key.trim());
          if (boatOrg.trim()) await setSecret(org.id, "BOAT_ORG", boatOrg.trim());
          await onNext();
        });
      }}
    >
      <Body>
        <Heading title="Connect Boat">
          Dorks Teams runs your sandboxes in your own Boat account. The key is stored encrypted for {org.name}. <A href="https://boat.dev/dashboard?tab=api-keys">Get a key</A>
        </Heading>
        <div className="flex flex-col gap-3">
          <SecretInput
            aria-label="boat api key"
            className={FIELD}
            autoComplete="off"
            autoFocus
            placeholder={saved ? "A key is saved" : "Paste your Boat API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          {askOrg ? (
            <Input aria-label="boat organization" className={FIELD} autoComplete="off" placeholder="Organization id" value={boatOrg} onChange={(e) => setBoatOrg(e.target.value)} />
          ) : (
            <button type="button" className="self-center text-xs text-muted-foreground hover:text-foreground" onClick={() => setAskOrg(true)}>
              My key belongs to several Boat organizations
            </button>
          )}
        </div>
      </Body>
      <Actions type="submit" disabled={pending}>
        {pending ? "Saving…" : "Continue"}
      </Actions>
      {!saved && <Skip onClick={() => onSkip()}>Skip for now</Skip>}
    </StepForm>
  );
}

// ---- 5. Agents ----------------------------------------------------------------------------------------------------------------

function Agents({ progress, onNext, onSkip }: StepProps) {
  const org = progress.org!;
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [claude, setClaude] = useState(progress.secrets.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  const { run, pending } = usePending();
  return (
    <>
      <Body>
        <Heading title="Connect your AI">Your team’s sessions run on the plans you already pay for. One is enough to start.</Heading>
        <List>
          <Row icon={<Logo {...LOGOS.claude} />} name="Claude" connected={claude} onOpen={() => setOpen(true)} />
          {/* Cloud sessions run Claude today; the others the desktop app runs come to cloud teams next. */}
          <Row icon={<Logo {...LOGOS.openai} className="scale-[1.3]" />} name="Codex" soon />
          <Row icon={<Logo {...LOGOS.antigravity} />} name="Antigravity" soon />
          <Row icon={<Logo {...LOGOS.opencode} />} name="OpenCode" soon />
        </List>
      </Body>
      <Actions onClick={() => (claude ? void onNext() : notify("Connect Claude first, or skip this step."))}>Finish</Actions>
      {!claude && <Skip onClick={() => onSkip()}>Skip for now</Skip>}

      <ConnectDialog
        open={open}
        onOpenChange={setOpen}
        title="Connect Claude"
        description={
          <>
            Run <code>claude setup-token</code> in a terminal and paste what it prints. It’s stored encrypted for {org.name}.
          </>
        }
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (!token.trim()) return notify("Paste the token first.");
            void run(async () => {
              await setSecret(org.id, "CLAUDE_CODE_OAUTH_TOKEN", token.trim());
              setClaude(true);
              setToken("");
              setOpen(false);
            });
          }}
        >
          <div className="dialog-body">
            <SecretInput aria-label="claude token" autoFocus autoComplete="off" placeholder={claude ? "A token is saved" : "sk-ant-oat01-…"} value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </ConnectDialog>
    </>
  );
}

// ---- Done ---------------------------------------------------------------------------------------------------------------------

const DOWNLOAD_URL = "/download";

/** Opened by the desktop: a one-time code for this session goes back to it through dorks://auth. Otherwise: get the app. */
function Done({ params, email }: { params: URLSearchParams; email: string }) {
  const state = appHandoffState(params);
  const [link, setLink] = useState<string>();
  const [error, setError] = useState("");
  const started = useRef(false);
  const handoff = () => {
    if (!state) return;
    setError("");
    appHandoffLink(state).then(
      (href) => {
        setLink(href);
        window.location.href = href;
      },
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    handoff();
  }, []);
  if (!state)
    return (
      <Message title="You’re all set" sub={`Signed in as ${email}. Open Dorks on your Mac and sign in to Dorks Cloud.`}>
        <Actions nativeButton={false} render={<a href={DOWNLOAD_URL} />}>
          Download for Mac
        </Actions>
      </Message>
    );
  if (error)
    return (
      <Message title="Couldn’t open Dorks" sub={error}>
        <Actions onClick={handoff}>Try again</Actions>
      </Message>
    );
  if (!link) return <Loading label="Opening Dorks…" />;
  return (
    <Message title="You can return to Dorks" sub={`Signed in as ${email}. Dorks didn’t open? Use the button below.`}>
      {/* A fresh code each press: the one in `link` is single-use and lasts 60 s. */}
      <Actions variant="outline" onClick={handoff}>
        Open Dorks
      </Actions>
    </Message>
  );
}

// ---- Pieces -------------------------------------------------------------------------------------------------------------------

/** A centred page in the steps' backdrop, without the dots: loading, the end, a failure. */
function Message({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="site-onboarding app-backdrop relative isolate flex min-h-svh flex-col items-center justify-center gap-8 p-12 tracking-[-0.02em] text-foreground">
      <div className="absolute inset-x-0 top-8 flex justify-center">
        <DorksMark size={24} />
      </div>
      <Heading title={title}>{sub}</Heading>
      {children}
    </div>
  );
}

function Loading({ label }: { label?: string }) {
  return (
    <div className="site-onboarding app-backdrop flex min-h-svh items-center justify-center">
      <p role="status" className="text-sm text-muted-foreground">
        {label ?? "Loading…"}
      </p>
    </div>
  );
}

/** The way past a step without answering it: one quiet line under the step's buttons. */
function Skip({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="-mt-4 self-center text-sm text-muted-foreground hover:text-foreground">
      {children}
    </button>
  );
}

/** One save at a time; a failure goes to the toast, the step's buttons stay enabled. */
function usePending() {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { run, pending };
}
