import { ChevronLeft, Mail } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DorksMark } from "#/components/DorksMark";
import { AppleIcon, GoogleIcon } from "#/components/icons";
import { Button } from "#/components/ui/button";
import { appNext, authClient, fetchSignInMethods, safeNext, sendEmailOtp, signInSocial, verifyEmailOtp, type SignInMethods } from "#/lib/cloud";
import { cn } from "#/lib/utils";

const DOWNLOAD_URL = "https://github.com/handlemotion/dorks/releases/latest";
const RESEND_AFTER_S = 30;

type Step = { kind: "choose" } | { kind: "email" } | { kind: "code"; email: string };

/**
 * Sign-in to Dorks Cloud, the iPhone app's: Apple, Google, then email (address, then a 6-digit code). Signed in, it goes to
 * ?next= (dorks.build or api.dorks.build only), or accepts the invitation on /invite/<id>, or says which account this is.
 */
export function SignIn({ invitationId }: { invitationId?: string }) {
  const session = authClient.useSession();
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const next = appNext(params) ?? safeNext(params.get("next"));
  const user = session.data?.user;

  useEffect(() => {
    if (user && next && !invitationId) window.location.replace(next);
  }, [user, next, invitationId]);

  if (session.isPending || (user && next && !invitationId))
    return (
      <Screen>
        <Spinner className="size-5 text-neutral-400" />
      </Screen>
    );
  if (user && invitationId) return <Invite id={invitationId} next={next} user={user} />;
  if (user) return <SignedIn user={user} />;
  if (step.kind === "email") return <EmailStep onBack={() => setStep({ kind: "choose" })} onSent={(email) => setStep({ kind: "code", email })} />;
  if (step.kind === "code") return <CodeStep email={step.email} onBack={() => setStep({ kind: "email" })} />;
  return <Choose invite={!!invitationId} providerError={params.get("error")} onEmail={() => setStep({ kind: "email" })} />;
}

function Choose({ invite, providerError, onEmail }: { invite: boolean; providerError: string | null; onEmail: () => void }) {
  const [methods, setMethods] = useState<SignInMethods>();
  const [pending, setPending] = useState<"google" | "apple" | null>(null);
  const [error, setError] = useState(providerError ? `Could not sign in with ${providerError === "apple" ? "Apple" : "Google"}.` : "");
  useEffect(() => {
    fetchSignInMethods().then(setMethods, () => setMethods(undefined));
  }, []);
  const social = (provider: "google" | "apple") => {
    setPending(provider);
    setError("");
    const back = new URL(window.location.href);
    back.searchParams.delete("error");
    signInSocial(provider, back.href).catch((e: Error) => {
      setPending(null);
      setError(e.message);
    });
  };
  return (
    <Layout
      title={invite ? "Sign in to join your team" : "Sign in to Dorks"}
      footer={
        <>
          By continuing, you agree to our
          <br />
          Terms of Service and Privacy Policy.
        </>
      }
    >
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button variant="outline" size="lg" disabled={!!pending || methods?.appleWeb !== true} onClick={() => social("apple")}>
        <Lead>{pending === "apple" ? <Spinner /> : <AppleIcon />}</Lead>
        Continue with Apple
      </Button>
      <Button variant="outline" size="lg" disabled={!!pending || methods?.google !== true} onClick={() => social("google")}>
        <Lead>{pending === "google" ? <Spinner /> : <GoogleIcon />}</Lead>
        Continue with Google
      </Button>
      <Button variant="outline" size="lg" disabled={!!pending || methods?.email === false} onClick={onEmail}>
        <Lead>
          <Mail className="size-4 stroke-[1.5]" />
        </Lead>
        Continue with email
      </Button>
    </Layout>
  );
}

function EmailStep({ onBack, onSent }: { onBack: () => void; onSent: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const send = useAction(sendEmailOtp);
  const valid = /^\S+@\S+\.\S+$/.test(email.trim());
  const submit = () => {
    const address = email.trim();
    if (valid && !send.isPending) void send.run(address).then((ok) => ok && onSent(address));
  };
  return (
    <Layout title="Continue with email" back={<BackPill onClick={onBack}>Back</BackPill>}>
      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          disabled={send.isPending}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={cn(FIELD, "h-11 w-full rounded-full px-4 text-sm placeholder:text-neutral-400 dark:placeholder:text-neutral-500")}
        />
        {send.error ? <ErrorText>{send.error}</ErrorText> : null}
        <Button type="submit" variant="ink" size="lg" disabled={!valid || send.isPending}>
          {send.isPending ? (
            <Lead>
              <Spinner />
            </Lead>
          ) : null}
          Continue
        </Button>
      </form>
    </Layout>
  );
}

function CodeStep({ email, onBack }: { email: string; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [wait, setWait] = useState(RESEND_AFTER_S);
  const verify = useAction((otp: string) => verifyEmailOtp(email, otp));
  const resend = useAction(() => sendEmailOtp(email));
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const submit = (value = code) => {
    if (value.length === 6 && !verify.isPending) void verify.run(value);
  };
  const error = resend.error ?? verify.error;
  return (
    <Layout
      title="Enter code"
      sub={email}
      footer={
        wait > 0 ? (
          <span>{`Resend in 00:${String(wait).padStart(2, "0")}`}</span>
        ) : (
          <FooterLink
            disabled={resend.isPending}
            onClick={() => {
              verify.reset();
              void resend.run().then((ok) => {
                if (!ok) return;
                setCode("");
                setWait(RESEND_AFTER_S);
              });
            }}
          >
            Resend code
          </FooterLink>
        )
      }
      back={<BackPill onClick={onBack}>Use another email</BackPill>}
    >
      <CodeBoxes
        value={code}
        invalid={!!verify.error && code.length === 6}
        disabled={verify.isPending}
        onChange={(digits) => {
          setCode(digits);
          verify.reset();
          resend.reset();
          if (digits.length === 6) submit(digits);
        }}
        onSubmit={() => submit()}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button variant="ink" size="lg" disabled={code.length < 6 || verify.isPending} onClick={() => submit()}>
        {verify.isPending ? (
          <Lead>
            <Spinner />
          </Lead>
        ) : null}
        Continue
      </Button>
    </Layout>
  );
}

/** Six boxes over one transparent field: typing, pasting and one-time-code autofill all fill it. */
function CodeBoxes({ value, onChange, onSubmit, invalid, disabled }: { value: string; onChange: (digits: string) => void; onSubmit: () => void; invalid?: boolean; disabled?: boolean }) {
  const [focused, setFocused] = useState(true);
  return (
    <div className="relative flex gap-2.5">
      {Array.from({ length: 6 }, (_, i) => {
        const current = focused && (i === value.length || (i === 5 && value.length === 6));
        return (
          <div
            key={i}
            aria-hidden="true"
            className={cn(
              FIELD,
              "flex h-11 flex-1 items-center justify-center rounded-xl text-lg",
              invalid ? "border-[#dc2626] dark:border-[#f87171]" : current ? "border-[#1d72e8] dark:border-[#1d72e8]" : "",
            )}
          >
            {value[i] ?? ""}
          </div>
        );
      })}
      <input
        aria-label="6-digit code"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-[0.011] outline-none"
      />
    </div>
  );
}

type User = { id: string; name: string; email: string };

function SignedIn({ user }: { user: User }) {
  return (
    <Layout title="You're signed in" footer={<Account user={user} />}>
      <DownloadButton />
      <Button variant="outline" size="lg" nativeButton={false} render={<a href="/docs/quickstart" />}>
        Get started
      </Button>
    </Layout>
  );
}

function Invite({ id, next, user }: { id: string; next: string | null; user: User }) {
  const [state, setState] = useState<{ kind: "joining" } | { kind: "joined"; org: string } | { kind: "failed"; message: string }>({ kind: "joining" });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const invitation = await authClient.organization.getInvitation({ query: { id } });
      if (invitation.error) throw new Error(invitation.error.message || "This invitation can't be opened.");
      const accepted = await authClient.organization.acceptInvitation({ invitationId: id });
      if (accepted.error) throw new Error(accepted.error.message || "Could not accept the invitation.");
      if (next) window.location.replace(next);
      else setState({ kind: "joined", org: invitation.data.organizationName });
    })().catch((e: Error) => setState({ kind: "failed", message: e.message }));
  }, [id, next]);

  if (state.kind === "joining")
    return (
      <Screen>
        <Spinner className="size-5 self-center text-neutral-400" />
      </Screen>
    );
  // No dorks://invite/<id> once joined: the invitation is accepted now, and the app's /invite/<id> only opens pending ones.
  return state.kind === "joined" ? (
    <Layout title={`You joined ${state.org}`} footer={<Account user={user} />}>
      <DownloadButton />
    </Layout>
  ) : (
    <Layout title="Can't join this team" sub={state.message} footer={<Account user={user} />} />
  );
}

/** Which account this is, and a way out of it. */
function Account({ user }: { user: User }) {
  const [out, setOut] = useState(false);
  return (
    <>
      {user.email}
      {" · "}
      <FooterLink
        disabled={out}
        onClick={() => {
          setOut(true);
          void authClient.signOut().finally(() => window.location.reload());
        }}
      >
        Sign out
      </FooterLink>
    </>
  );
}

function DownloadButton() {
  return (
    <Button variant="outline" size="lg" nativeButton={false} render={<a href={DOWNLOAD_URL} />}>
      <Lead>
        <AppleIcon />
      </Lead>
      Download for Mac
    </Button>
  );
}

/** The fill and hairline of every field (the email input, the code boxes): the outline button's. */
const FIELD = "border border-[#e8e8e8] bg-white text-neutral-950 outline-none focus:border-[#1d72e8] disabled:opacity-50 dark:border-white/10 dark:bg-[#171717] dark:text-neutral-50";

/** The page: content centred on white, like the app. */
function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-white px-6 py-12 text-neutral-950 dark:bg-[#0a0a0a] dark:text-neutral-50">
      <div className="flex w-full max-w-[360px] flex-col items-stretch">{children}</div>
    </main>
  );
}

/**
 * Every sign-in page, one layout: the mark and the title (and at most one short line), a 10px stack of controls, and one
 * small quiet line under them (the legal line, the resend timer, the account), and a small Back pill on the email steps.
 */
function Layout({ title, sub, children, footer, back }: { title: string; sub?: ReactNode; children?: ReactNode; footer?: ReactNode; back?: ReactNode }) {
  return (
    <Screen>
      <div className="flex flex-col items-center gap-5 pb-10 text-center">
        <DorksMark size={32} />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl leading-8 font-medium tracking-[-0.02em]">{title}</h1>
          {sub ? <p className="text-sm text-neutral-500 dark:text-neutral-400">{sub}</p> : null}
        </div>
      </div>
      {children ? <div className="flex flex-col gap-2.5">{children}</div> : null}
      {footer ? <p className="pt-6 text-center text-xs leading-[17px] text-neutral-400 dark:text-neutral-500">{footer}</p> : null}
      {back ? <div className="flex justify-center pt-6">{back}</div> : null}
    </Screen>
  );
}

/** The way back from an email step: a small outline pill. */
function BackPill({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="gap-1 pl-2.5" onClick={onClick}>
      <ChevronLeft className="size-4 stroke-[1.5]" />
      {children}
    </Button>
  );
}

/** A link-styled action in the footer line. */
function FooterLink({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="cursor-pointer text-neutral-500 hover:text-neutral-950 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-50">
      {children}
    </button>
  );
}

/** The glyph at a button's leading edge, so labels in a stack share one centre line. */
function Lead({ children }: { children: ReactNode }) {
  return <span className="absolute top-0 bottom-0 left-4 flex w-4 items-center justify-center">{children}</span>;
}

function Spinner({ className }: { className?: string }) {
  return <span aria-label="Loading" role="status" className={cn("inline-block size-4 animate-spin rounded-full border-[1.5px] border-current border-t-transparent", className)} />;
}

function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("text-center text-[13px] leading-[18px] text-[#dc2626] dark:text-[#f87171]", className)}>
      {children}
    </p>
  );
}

/** One async action: `run` resolves true when it succeeded; `error` holds the last failure's message. */
function useAction<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  const [state, setState] = useState<{ isPending: boolean; error: string | null }>({ isPending: false, error: null });
  const latest = useRef(fn);
  latest.current = fn;
  const run = useCallback(async (...args: A) => {
    setState({ isPending: true, error: null });
    try {
      await latest.current(...args);
      setState({ isPending: false, error: null });
      return true;
    } catch (e) {
      setState({ isPending: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, []);
  const reset = useCallback(() => setState((s) => (s.error ? { ...s, error: null } : s)), []);
  return { ...state, run, reset };
}
