import { authClient, CLOUD_URL } from "#/lib/cloud";

/**
 * Dorks Cloud onboarding (/onboarding): the steps, what the relay says about each, and the desktop handoff at the end. Every answer
 * is saved to the relay as it is given (the org through Better Auth's organization API, keys as org secrets), so a reload or another
 * browser resumes at the first step still open. The only things kept in this browser are the steps the visitor passed without
 * saving anything (skipped, or read the included-sandboxes note), per org.
 */
export type StepId = "workspace" | "plan" | "invite" | "boat" | "agents";

/**
 * A team needs a plan before anything else can be saved to it: org secrets (the Boat key, the Claude token) answer 403 plan_required
 * on Dorks Local, and Local's member limit is 1, so an invitation would be refused. So the plan comes right after the name.
 */
export const STEPS: readonly StepId[] = ["workspace", "plan", "invite", "boat", "agents"];

export type Plan = "local" | "teams" | "cloud";
export const isPaid = (plan: Plan | undefined) => plan === "teams" || plan === "cloud";

export interface Org {
  id: string;
  name: string;
  slug: string;
  personal: boolean;
  role: string;
  plan: Plan;
}

export interface Invitation {
  id: string;
  email: string;
  status: string;
}

export interface Progress {
  org: Org | null;
  /** Names of the org's secrets (never values). */
  secrets: string[];
  invitations: Invitation[];
  /** A team the visitor is in but does not own, with nothing of their own to set up: an existing account, so onboarding is done. */
  memberOnly: boolean;
}

export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A JSON call to the relay with the browser's session cookie; the relay's {error: {code, message}} becomes a CloudError. */
export async function cloud<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${CLOUD_URL}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    credentials: "include",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await r.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!r.ok) throw new CloudError(r.status, data?.error?.code ?? String(r.status), data?.error?.message || `Dorks Cloud answered ${r.status}`);
  return data as T;
}

// ---- What this browser remembers --------------------------------------------------------------------------------------------

const KEY = "dorks.cloudOnboarding";
interface Stored {
  orgId?: string;
  /** Per org: steps passed without saving anything. */
  passed?: Record<string, StepId[]>;
}
const read = (): Stored => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Stored;
  } catch {
    return {};
  }
};
const store = (s: Stored) => localStorage.setItem(KEY, JSON.stringify(s));

export const rememberOrg = (orgId: string) => store({ ...read(), orgId });
export function markPassed(orgId: string, step: StepId) {
  const s = read();
  const passed = new Set(s.passed?.[orgId] ?? []);
  passed.add(step);
  store({ ...s, passed: { ...s.passed, [orgId]: [...passed] } });
}
const passedSteps = (orgId: string) => new Set(read().passed?.[orgId] ?? []);

// ---- Progress ---------------------------------------------------------------------------------------------------------------

/**
 * The team being set up: the one this browser started, else the first team the visitor owns. Its plan, secrets and invitations come
 * from the relay.
 */
export async function loadProgress(): Promise<Progress> {
  const orgs = await cloud<Org[]>("/v1/orgs");
  const teams = orgs.filter((o) => !o.personal);
  const saved = read().orgId;
  const org = teams.find((o) => o.id === saved) ?? teams.find((o) => o.role === "owner") ?? null;
  if (!org) return { org: null, secrets: [], invitations: [], memberOnly: teams.length > 0 };
  const [secrets, invitations] = await Promise.all([
    isPaid(org.plan)
      ? cloud<{ secrets: { name: string }[] }>(`/v1/orgs/${org.id}/runtime/secrets`).then(
          (r) => r.secrets.map((s) => s.name),
          () => [],
        )
      : Promise.resolve([]),
    authClient.organization.listInvitations({ query: { organizationId: org.id } }).then(
      (r) => ((r.data ?? []) as Invitation[]).filter((i) => i.status === "pending"),
      () => [],
    ),
  ]);
  return { org, secrets, invitations, memberOnly: false };
}

/** Whether each step needs nothing more. */
export function stepDone(p: Progress): Record<StepId, boolean> {
  const passed = p.org ? passedSteps(p.org.id) : new Set<StepId>();
  const has = (name: string) => p.secrets.includes(name);
  return {
    workspace: !!p.org,
    plan: isPaid(p.org?.plan),
    invite: passed.has("invite") || p.invitations.length > 0,
    // Dorks Cloud brings its own sandboxes; the step only says so once.
    boat: passed.has("boat") || has("BOAT_API_KEY"),
    agents: passed.has("agents") || has("CLAUDE_CODE_OAUTH_TOKEN"),
  };
}

/** The first step still open, or null when onboarding is answered (or there is nothing for this account to set up). */
export function firstOpenStep(p: Progress): StepId | null {
  if (p.memberOnly) return null;
  const done = stepDone(p);
  return STEPS.find((s) => !done[s]) ?? null;
}

// ---- Saving -----------------------------------------------------------------------------------------------------------------

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "team";

/** Creates the team (its creator is its owner and it becomes the session's active org), or renames the one already started. */
export async function saveWorkspace(name: string, existing: Org | null): Promise<void> {
  if (existing) {
    if (existing.name === name) return;
    const r = await authClient.organization.update({ organizationId: existing.id, data: { name } });
    if (r.error) throw new Error(r.error.message || "Could not rename the workspace");
    return;
  }
  // The slug is only an address; a short random tail keeps two teams with one name apart.
  const slug = `${slugify(name)}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).slice(0, 5)}`;
  const r = await authClient.organization.create({ name, slug });
  if (r.error || !r.data) throw new Error(r.error?.message || "Could not create the workspace");
  rememberOrg(r.data.id);
}

export const setSecret = (orgId: string, name: string, value: string) => cloud(`/v1/orgs/${orgId}/runtime/secrets/${name}`, { method: "PUT", body: { value } });

export async function invite(orgId: string, email: string) {
  const r = await authClient.organization.inviteMember({ organizationId: orgId, email, role: "member" });
  if (r.error) throw new Error(r.error.message || `Could not invite ${email}`);
}

export interface Plans {
  plans: Record<Plan, { name: string; monthlyCents: number; includedMinutes: number; maxConcurrentSandboxes: number }>;
}
export const fetchPlans = () => cloud<Plans>("/v1/billing/plans");

/**
 * Stripe Checkout for the plan's trial (Teams: 14 days; Cloud: no time limit, 10 sandbox hours; both take a card and charge nothing
 * up front). Stripe comes back to this page with ?checkout=success (or cancel), the rest of the query (app, state) kept.
 */
export async function startCheckout(orgId: string, plan: "teams" | "cloud") {
  const back = (result: string) => {
    const u = new URL(window.location.href);
    u.searchParams.set("checkout", result);
    return u.href;
  };
  const { url } = await cloud<{ url: string }>(`/v1/billing/orgs/${orgId}/checkout`, { body: { plan, trial: true, successUrl: back("success"), cancelUrl: back("cancel") } });
  window.location.assign(url);
}

/** After Checkout: the webhook lands a moment later, so wait (up to ~30 s) for the org's plan to turn paid. */
export async function waitForPlan(orgId: string): Promise<Plan> {
  for (let i = 0; i < 15; i++) {
    const { plan } = await cloud<{ plan: Plan }>(`/v1/orgs/${orgId}/entitlements`);
    if (isPaid(plan)) return plan;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "local";
}

// ---- The desktop handoff ----------------------------------------------------------------------------------------------------

/** The desktop opened this browser (`/login?next=/onboarding&app=1&state=<nonce>`): the nonce its local server will check. */
export function appHandoffState(params: URLSearchParams): string | null {
  const state = params.get("state");
  return params.get("app") === "1" && state && /^[A-Za-z0-9_-]{16,256}$/.test(state) ? state : null;
}

/** A one-time code (60 s) for this session, bound to `state`, and the dorks:// link that hands it to the desktop. */
export async function appHandoffLink(state: string): Promise<string> {
  const { code } = await cloud<{ code: string }>("/v1/app-handoff", { body: { state } });
  const link = new URL("dorks://auth");
  link.searchParams.set("code", code);
  link.searchParams.set("state", state);
  return link.href;
}
