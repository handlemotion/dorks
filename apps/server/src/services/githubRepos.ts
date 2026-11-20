import { Effect, Schema } from "effect";
import type { App } from "../app";
import { getCached, type GithubClient } from "../lib/github";
import { githubToken } from "./settings";

/** `GET /api/github/repos`: who the saved GitHub token acts as, the organizations it belongs to, and the repositories it can push to. */
export interface GithubRepos {
  /** The token's user, or null without a token (or when GitHub could not be reached). */
  login: string | null;
  /** Organization logins, sorted. */
  orgs: string[];
  /** `owner/name`, most recently pushed first. */
  repos: string[];
}

const TTL_MS = 2 * 60_000;
/** Pages of 100 repositories; enough for the picker, which also takes any typed `owner/repo`. */
const MAX_PAGES = 3;
const EMPTY: GithubRepos = { login: null, orgs: [], repos: [] };
const cache = new WeakMap<App, { at: number; value: GithubRepos }>();

const Viewer = Schema.Struct({ login: Schema.String });
const Orgs = Schema.Array(Schema.Struct({ login: Schema.String }));
const Repos = Schema.Array(Schema.Struct({ full_name: Schema.String, archived: Schema.optional(Schema.Boolean) }));

/** What the token can see on GitHub, cached briefly. Never fails: without a token, or when GitHub fails, the lists are empty. */
export async function githubRepos(app: App): Promise<GithubRepos> {
  const cached = cache.get(app);
  if (cached && app.now() - cached.at < TTL_MS) return cached.value;
  const token = await githubToken(app);
  if (!token) return EMPTY;
  const gh: GithubClient = { fetch: app.fetch, token, now: () => app.now() };
  const body = <T>(r: { status: 304 } | { status: 200; json: T }, empty: T) => (r.status === 200 ? r.json : empty);
  const value = await Effect.runPromise(
    Effect.gen(function* () {
      const [viewer, orgs] = yield* Effect.all(
        [getCached(gh, Viewer, "/user").pipe(Effect.map((r) => body(r, { login: "" }).login || null)), getCached(gh, Orgs, "/user/orgs?per_page=100").pipe(Effect.map((r) => body(r, [])))],
        { concurrency: 2 },
      );
      const repos: string[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const list = body(yield* getCached(gh, Repos, `/user/repos?per_page=100&sort=pushed&page=${page}`), []);
        repos.push(...list.filter((r) => !r.archived).map((r) => r.full_name));
        if (list.length < 100) break;
      }
      return { login: viewer, orgs: orgs.map((o) => o.login).sort((a, b) => a.localeCompare(b)), repos } satisfies GithubRepos;
    }).pipe(Effect.orElseSucceed(() => EMPTY)),
  );
  // A failure is not cached, so the next open tries again.
  if (value !== EMPTY) cache.set(app, { at: app.now(), value });
  return value;
}

/** Drop the cache, so a changed token shows on the next read. */
export function forgetGithubRepos(app: App): void {
  cache.delete(app);
}
