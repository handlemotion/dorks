// Proves a GitHub App installation belongs to the signed-in user (GitHub's "Request user authorization (OAuth) during
// installation" flow): exchange the callback `code` for a user-to-server token, then require the installation id to appear in
// GET /user/installations. A raw installation id from the client proves nothing and must never be trusted.
const UA = "dorks-convex"; // GitHub rejects requests without a User-Agent
const MAX_PAGES = 10;

export interface GithubOAuthApp {
  clientId: string;
  clientSecret: string;
}

export async function exchangeUserCode(code: string, app: GithubOAuthApp, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
  });
  if (!res.ok) throw new Error(`GitHub code exchange failed: ${res.status}`);
  const j = (await res.json()) as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`GitHub code exchange rejected: ${j.error ?? "no token"}`); // never echo the code/body
  return j.access_token;
}

/** True only if `installationId` is among the installations the token's user can access. */
export async function userHasInstallation(userToken: string, installationId: number, fetcher: typeof fetch = fetch): Promise<boolean> {
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetcher(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${userToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`GitHub installations lookup failed: ${res.status}`);
    const j = (await res.json()) as { total_count: number; installations: { id: number }[] };
    if (j.installations.some((i) => i.id === installationId)) return true;
    seen += j.installations.length;
    if (!j.installations.length || seen >= j.total_count) return false;
  }
  return false;
}

/** The GitHub login the token belongs to. */
export async function userLogin(userToken: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${userToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`GitHub user lookup failed: ${res.status}`);
  return ((await res.json()) as { login: string }).login;
}

/** Full check used by the Convex action: the user's GitHub login if they can see the installation, else null. */
export async function verifyInstallationOwnership(code: string, installationId: number, app: GithubOAuthApp, fetcher: typeof fetch = fetch): Promise<{ login: string } | null> {
  const token = await exchangeUserCode(code, app, fetcher);
  return (await userHasInstallation(token, installationId, fetcher)) ? { login: await userLogin(token, fetcher) } : null;
}
