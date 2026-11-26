import { Mail } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DorksMark } from "#/components/DorksMark";
import { AppleIcon, GoogleIcon } from "#/components/icons";
import { Button } from "#/components/ui/button";
import { authClient, fetchSignInMethods, safeNext, sendEmailOtp, signInSocial, verifyEmailOtp, type SignInMethods } from "#/lib/cloud";
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
  const next = safeNext(params.get("next"));
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
    <Screen>
      <div className="flex flex-col items-center gap-5 pb-10 text-center">
        <DorksMark size={36} />
        <h1 className="text-[26px] leading-8 font-medium tracking-[-0.02em]">{invite ? "Sign in to join your team" : "Sign in to Dorks"}</h1>
      </div>
      <div className="flex flex-col gap-[18px]">
        {error ? <ErrorText>{error}</ErrorText> : null}
        <div className="flex flex-col gap-2.5">
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
              <Mail className="size-[18px] stroke-[1.5]" />
            </Lead>
            Continue with email
          </Button>
        </div>
        <p className="text-center text-xs leading-[17px] text-neutral-400 dark:text-neutral-500">
          By continuing, you agree to our
          <br />
          Terms of Service and Privacy Policy.
        </p>
      </div>
    </Screen>
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
    <Page title="Continue with email" back="Back" onBack={onBack}>
      <form
        className="flex flex-col gap-4"
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
          className="h-12 w-full rounded-full border border-[#e8e8e8] bg-white px-5 text-[15px] text-neutral-950 outline-none placeholder:text-neutral-400 focus:border-[#1d72e8] disabled:opacity-50 dark:border-white/10 dark:bg-[#171717] dark:text-neutral-50 dark:placeholder:text-neutral-500"
        />
        {send.error ? <ErrorText>{send.error}</ErrorText> : null}
        <Button type="submit" variant="inverse" size="lg" disabled={!valid || send.isPending}>
          {send.isPending ? (
            <Lead>
              <Spinner />
            </Lead>
          ) : null}
          Continue
        </Button>
      </form>
    </Page>
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
    <Page title="Enter code" detail={email} back="Use another email" onBack={onBack}>
      <div className="flex flex-col gap-4">
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
        <div className="flex min-h-9 items-center justify-center">
          {wait > 0 ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">{`Resend code in 00:${String(wait).padStart(2, "0")}`}</p>
          ) : (
            <Button
              variant="quiet"
              size="sm"
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
              {resend.isPending ? <Spinner /> : null}
              Resend code
            </Button>
          )}
        </div>
        <Button variant="inverse" size="lg" disabled={code.length < 6 || verify.isPending} onClick={() => submit()}>
          {verify.isPending ? (
            <Lead>
              <Spinner />
            </Lead>
          ) : null}
          Continue
        </Button>
      </div>
    </Page>
  );
}

/** Six boxes over one transparent field: typing, pasting and one-time-code autofill all fill it. */
function CodeBoxes({ value, onChange, onSubmit, invalid, disabled }: { value: string; onChange: (digits: string) => void; onSubmit: () => void; invalid?: boolean; disabled?: boolean }) {
  const [focused, setFocused] = useState(true);
  return (
    <div className="relative flex gap-2">
      {Array.from({ length: 6 }, (_, i) => {
        const current = focused && (i === value.length || (i === 5 && value.length === 6));
        return (
          <div
            key={i}
            aria-hidden="true"
            className={cn(
              "flex h-14 flex-1 items-center justify-center rounded-[14px] border bg-white text-2xl font-medium dark:bg-[#171717]",
              invalid ? "border-[#dc2626] dark:border-[#f87171]" : current ? "border-[#1d72e8]" : "border-[#e8e8e8] dark:border-white/10",
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
    <Screen>
      <div className="flex flex-col items-center gap-5 pb-10 text-center">
        <DorksMark size={36} />
        <div className="flex flex-col gap-2">
          <h1 className="text-[26px] leading-8 font-medium tracking-[-0.02em]">You're signed in</h1>
          <Account user={user} />
        </div>
      </div>
      <Downloads />
    </Screen>
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
        <Spinner className="size-5 text-neutral-400" />
      </Screen>
    );
  return (
    <Screen>
      <div className="flex flex-col items-center gap-5 pb-10 text-center">
        <DorksMark size={36} />
        <div className="flex flex-col gap-2">
          <h1 className="text-[26px] leading-8 font-medium tracking-[-0.02em]">{state.kind === "joined" ? `You joined ${state.org}` : "Can't join this team"}</h1>
          {state.kind === "failed" ? <p className="text-[15px] leading-[22px] text-neutral-500 dark:text-neutral-400">{state.message}</p> : null}
          {state.kind === "joined" ? <p className="text-[15px] leading-[22px] text-neutral-500 dark:text-neutral-400">Open Dorks on your Mac and pick {state.org} in the team switcher.</p> : null}
          <Account user={user} />
        </div>
      </div>
      {state.kind === "joined" ? (
        // No dorks://invite/<id> here: the invitation is accepted now, and the app's /invite/<id> only opens pending ones.
        <div className="flex flex-col gap-2.5">
          <Button variant="inverse" size="lg" nativeButton={false} render={<a href={DOWNLOAD_URL} />}>
            <Lead>
              <AppleIcon />
            </Lead>
            Download for Mac
          </Button>
        </div>
      ) : null}
    </Screen>
  );
}

/** Which account this is, and a way out of it. */
function Account({ user }: { user: User }) {
  const [out, setOut] = useState(false);
  const shown = user.name && user.name !== user.email ? `${user.name} (${user.email})` : user.email;
  return (
    <p className="text-[15px] leading-[22px] text-neutral-500 dark:text-neutral-400">
      Signed in as <span className="font-medium text-neutral-950 dark:text-neutral-50">{shown}</span>.{" "}
      <button
        type="button"
        disabled={out}
        onClick={() => {
          setOut(true);
          void authClient.signOut().finally(() => window.location.reload());
        }}
        className="cursor-pointer underline decoration-neutral-300 underline-offset-4 hover:text-neutral-950 disabled:opacity-50 dark:decoration-neutral-600 dark:hover:text-neutral-50"
      >
        Sign out
      </button>
    </p>
  );
}

function Downloads() {
  return (
    <div className="flex flex-col gap-2.5">
      <Button variant="inverse" size="lg" nativeButton={false} render={<a href={DOWNLOAD_URL} />}>
        <Lead>
          <AppleIcon />
        </Lead>
        Download for Mac
      </Button>
      <Button variant="outline" size="lg" nativeButton={false} render={<a href="/docs/quickstart" />}>
        Get started
      </Button>
    </div>
  );
}

/** The page: content centred on the off-grey plane. */
function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-[#fafafa] px-6 py-12 text-neutral-950 dark:bg-[#0a0a0a] dark:text-neutral-50">
      <div className="flex w-full max-w-[360px] flex-col items-stretch">{children}</div>
    </main>
  );
}

/** An email step, laid out like the first page: the mark and a title centred, the form, then a quiet way back. */
function Page({ title, detail, back, onBack, children }: { title: string; detail?: ReactNode; back: string; onBack: () => void; children: ReactNode }) {
  return (
    <Screen>
      <div className="flex flex-col items-center gap-5 pb-8 text-center">
        <DorksMark size={36} />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[26px] leading-8 font-medium tracking-[-0.02em]">{title}</h1>
          {detail ? <p className="text-[15px] leading-[22px] text-neutral-500 dark:text-neutral-400">{detail}</p> : null}
        </div>
      </div>
      {children}
      <div className="flex justify-center pt-3">
        <Button variant="quiet" size="sm" className="text-neutral-500 dark:text-neutral-400" onClick={onBack}>
          {back}
        </Button>
      </div>
    </Screen>
  );
}

/** The glyph at a button's leading edge, so labels in a stack share one centre line. */
function Lead({ children }: { children: ReactNode }) {
  return <span className="absolute top-0 bottom-0 left-5 flex w-[18px] items-center justify-center">{children}</span>;
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
