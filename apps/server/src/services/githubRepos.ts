import { Effect, Schema } from "effect";
import type { App } from "../app";
import { update } from "../db";
import { getCached, type GithubClient } from "../lib/github";
import { forgetGhLogin, githubLogin, readSettings } from "./settings";

/**
 * How the GitHub connection stands: `ok`; `not_connected` (the owner has not connected GitHub); `gh_missing` / `gh_logged_out`
 * (the GitHub CLI is not installed, or not signed in); `rejected` (GitHub refused its token); `unreachable` (GitHub did not answer).
 */
export type GithubAuthState = "ok" | "not_connected" | "gh_missing" | "gh_logged_out" | "rejected" | "unreachable";

/** `GET /api/github/repos`: who Dorks acts as on GitHub, the organizations it belongs to, and the repositories it can see. */
export interface GithubRepos {
  /** The GitHub CLI's user, or null when not connected (or when GitHub could not be reached). */
  login: string | null;
  /** Organization logins, sorted. */
  orgs: string[];
  /** `owner/name`: the user's repositories by most recent push, then each organization's. */
  repos: string[];
  auth: {
    state: GithubAuthState;
    /** `gh`: the GitHub CLI's login; `env`: `GH_TOKEN` / `GITHUB_TOKEN` in the server's environment (development). */
    source: "gh" | "env" | null;
    /**
     * OAuth scopes Dorks needs that the token lacks (`read:org` lists organizations, `workflow` lets the agent push CI files).
     * Empty for tokens without scopes (fine-grained or app tokens), whose access GitHub decides per repository.
     */
    missingScopes: string[];
  };
}

/** What a GitHub CLI login needs: `repo` to clone and push, `read:org` to list organizations, `workflow` to push `.github/workflows`. */
export const NEEDED_SCOPES = ["repo", "read:org", "workflow"] as const;
const TTL_MS = 2 * 60_000;
/** Pages of 100 of the user's repositories; enough for the picker, which also takes any typed `owner/repo`. */
const MAX_PAGES = 3;
/** Organizations whose repositories are listed one page each (beyond these, their repositories still show through the user's list). */
const MAX_ORGS = 20;
const cache = new WeakMap<App, { at: number; value: GithubRepos }>();

const Orgs = Schema.Array(Schema.Struct({ login: Schema.String }));
const Repos = Schema.Array(Schema.Struct({ full_name: Schema.String, archived: Schema.optional(Schema.Boolean) }));

const empty = (state: GithubAuthState, source: GithubRepos["auth"]["source"] = null, login: string | null = null): GithubRepos => ({
  login,
  orgs: [],
  repos: [],
  auth: { state, source, missingScopes: [] },
});

/** `GET /user` with its headers: the login, and the OAuth scopes the token carries (null for tokens that have none). */
async function viewer(app: App, token: string): Promise<{ status: number; login?: string; scopes: string[] | null }> {
  const res = await app.fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dorks" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { status: res.status, scopes: null };
  const header = res.headers.get("x-oauth-scopes");
  const j = (await res.json().catch(() => null)) as { login?: unknown } | null;
  return {
    status: res.status,
    login: typeof j?.login === "string" ? j.login : undefined,
    scopes:
      header === null
        ? null
        : header
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
  };
}

/** Scopes in `NEEDED_SCOPES` that `scopes` does not grant. `repo` is implied by nothing else; `read:org` also by `admin:org`/`write:org`. */
export function missingScopes(scopes: string[] | null): string[] {
  if (!scopes) return [];
  const has = new Set(scopes);
  return NEEDED_SCOPES.filter((s) => !has.has(s) && !(s === "read:org" && (has.has("admin:org") || has.has("write:org"))));
}

/** What the GitHub CLI's login can see, cached briefly. Never fails: every problem is an `auth.state` with empty lists. */
export async function githubRepos(app: App, opts: { fresh?: boolean } = {}): Promise<GithubRepos> {
  if (opts.fresh) {
    // Read gh and GitHub again, and let a failure replace a cached success.
    forgetGhLogin(app);
    cache.delete(app);
  }
  const cached = cache.get(app);
  if (!opts.fresh && cached && app.now() - cached.at < TTL_MS) return cached.value;
  const read = await githubLogin(app);
  if (!read) return empty("not_connected");
  if ("problem" in read) return empty(read.problem);
  const source = read.source;

  let me: Awaited<ReturnType<typeof viewer>>;
  try {
    me = await viewer(app, read.token);
  } catch {
    return empty("unreachable", source);
  }
  if (me.status === 401) return empty("rejected", source);
  if (!me.login) return empty("unreachable", source);
  // The poller ignores the agent's own activity by this login; keep it current after `gh auth switch`.
  if (readSettings(app).githubLogin !== me.login) update(app.db, "settings", { id: 1 }, { githubLogin: me.login });

  const gh: GithubClient = { fetch: app.fetch, token: read.token, now: () => app.now() };
  const body = <T>(r: { status: 304 } | { status: 200; json: T }, none: T) => (r.status === 200 ? r.json : none);
  const lists = await Effect.runPromise(
    Effect.gen(function* () {
      const orgs = body(yield* getCached(gh, Orgs, "/user/orgs?per_page=100"), [])
        .map((o) => o.login)
        .sort((a, b) => a.localeCompare(b));
      const repos: string[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const list = body(yield* getCached(gh, Repos, `/user/repos?per_page=100&sort=pushed&page=${page}`), []);
        repos.push(...list.filter((r) => !r.archived).map((r) => r.full_name));
        if (list.length < 100) break;
      }
      // Each organization's most recently pushed repositories, so every organization has something to pick even when the
      // user's own list is full. One that hides itself from this login (an OAuth app policy) just adds nothing.
      const perOrg = yield* Effect.all(
        orgs.slice(0, MAX_ORGS).map((org) =>
          getCached(gh, Repos, `/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed`).pipe(
            Effect.map((r) =>
              body(r, [])
                .filter((x) => !x.archived)
                .map((x) => x.full_name),
            ),
            Effect.orElseSucceed(() => [] as string[]),
          ),
        ),
        { concurrency: 4 },
      );
      return { orgs, repos: [...new Set([...repos, ...perOrg.flat()])] };
    }).pipe(Effect.orElseSucceed(() => null)),
  );
  if (!lists) return empty("unreachable", source, me.login);
  const value: GithubRepos = { login: me.login, ...lists, auth: { state: "ok", source, missingScopes: missingScopes(me.scopes) } };
  cache.set(app, { at: app.now(), value });
  return value;
}

/** Drop the cache, so a changed login shows on the next read. */
export function forgetGithubRepos(app: App): void {
  cache.delete(app);
}
