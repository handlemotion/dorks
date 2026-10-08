// GitHub App primitives on WebCrypto only (no Node crypto, no octokit). The private key secret must be PKCS#8:
//   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
const UA = "dorks-api"; // Workers fetch sends no User-Agent; GitHub rejects such requests with 403

const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function importPkcs8(pem: string) {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) throw new Error("GitHub App key is PKCS#1; convert to PKCS#8 (see github.ts)");
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function createAppJwt(appId: string, pkcs8Pem: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importPkcs8(pkcs8Pem), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/**
 * What the agent needs to push a branch, open a PR and keep it healthy (docs/autonomy.md): contents (git push), pull_requests and
 * issues (PR comments and replies), workflows (CI config fixes) write; checks, actions and statuses read (CI results and
 * `gh run view --log-failed`). `metadata:read` is implicit on every token. Must be a subset of what the App itself is granted
 * (see docs/github-app.md), else GitHub answers 422.
 */
export const AGENT_TOKEN_PERMISSIONS = {
  contents: "write", pull_requests: "write", issues: "write", workflows: "write",
  checks: "read", actions: "read", statuses: "read",
} as const;

export interface TokenScope {
  /** Repository names (without owner) the token may touch. Omitting the scope yields a token for every repo of the installation. */
  repositories?: string[];
  permissions?: Record<string, "read" | "write">;
}

/** Token for a box: every repo of the installation (the agent may work in any of them), with the permissions above. */
export const agentTokenScope = (): TokenScope => ({ permissions: { ...AGENT_TOKEN_PERMISSIONS } });

/** GitHub answered non-2xx. Carries only the status: the response body is never surfaced. */
export class GithubHttpError extends Error {
  constructor(readonly status: number, what = "installation token") {
    super(`GitHub ${what} failed: ${status}`);
  }
}

export async function createInstallationToken(
  env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">,
  installationId: number | string,
  fetcher: typeof fetch = fetch,
  scope?: TokenScope,
): Promise<{ token: string; expiresAt: string; /** `owner/name` of the repos the token covers, when GitHub reports them (it does for a scoped token) */ repositories?: string[] }> {
  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetcher(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA,
      ...(scope ? { "Content-Type": "application/json" } : {}),
    },
    ...(scope ? { body: JSON.stringify({ repositories: scope.repositories, permissions: scope.permissions }) } : {}),
  });
  if (!res.ok) throw new GithubHttpError(res.status);
  const j = (await res.json()) as { token: string; expires_at: string; repositories?: { full_name: string }[] };
  return { token: j.token, expiresAt: j.expires_at, ...(j.repositories ? { repositories: j.repositories.map((r) => r.full_name) } : {}) };
}

export interface PullRequestInfo {
  title: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  state: "open" | "closed" | "merged";
  /** null = GitHub has not computed it yet. */
  mergeable: boolean | null;
  /** Canonical `owner/name` of the base repo. */
  repo: string;
}

/** `GET /repos/{repo}/pulls/{number}` with an installation token. 404 = the installation cannot see the PR. */
export async function getPullRequest(token: string, repo: string, number: number, fetcher: typeof fetch = fetch): Promise<PullRequestInfo> {
  const res = await fetcher(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA },
  });
  if (!res.ok) throw new GithubHttpError(res.status, "pull request lookup");
  const j = (await res.json()) as { title: string; state: "open" | "closed"; merged?: boolean; mergeable: boolean | null; head: { ref: string; sha: string }; base: { ref: string; repo: { full_name: string } } };
  return {
    title: j.title, headRef: j.head.ref, headSha: j.head.sha, baseRef: j.base.ref, repo: j.base.repo.full_name,
    state: j.merged ? "merged" : j.state, mergeable: j.mergeable ?? null,
  };
}

/** Constant-time check of X-Hub-Signature-256 over the raw body. */
export async function verifyWebhook(secret: string, rawBody: string, signatureHeader: string | null): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader ?? "");
  if (!m) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(m[1].match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(rawBody));
}

export type PrEvent = { kind: "pr_opened" | "pr_merged"; repo: string; branch: string; url: string; number: number };

/** Maps a pull_request webhook payload to a dorks event; fork PRs reusing an agent/* branch name are ignored. */
export function parsePullRequestEvent(payload: any): PrEvent | null {
  const pr = payload?.pull_request;
  const repo = payload?.repository?.full_name;
  if (!pr || !repo || pr.head?.repo?.full_name !== repo) return null;
  const base = { repo, branch: pr.head.ref as string, url: pr.html_url as string, number: pr.number as number };
  if (payload.action === "opened") return { kind: "pr_opened", ...base };
  if (payload.action === "closed" && pr.merged === true) return { kind: "pr_merged", ...base };
  return null;
}
