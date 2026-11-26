import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// The Codex CLI on this computer, for one thing: Dorks' own ChatGPT sign-in for Codex sessions (services/codexSignIn.ts). Dorks never
// talks to OpenAI's OAuth itself: it runs Codex's own browser sign-in through `codex app-server` (`account/login/start`), in a Codex
// home of its own (`<data dir>/codex`), so the refresh token never collides with the owner's own `codex login` (both rotate it).
// A sandbox never gets that refresh token: `tokens()` hands out the current access token, and Codex here refreshes it when it is
// about to expire, or when a sandbox reports it refused (the bridge's `codex_token`).

const EXTRA_DIRS = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const LINK_TIMEOUT_MS = 30_000;
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** An access token this close to expiry is refreshed before it is handed out. */
const REFRESH_MARGIN_S = 5 * 60;

export class CodexCliError extends Error {}

/** What a sandbox's Codex needs to sign in (`account/login/start` `chatgptAuthTokens`). Never the refresh token. */
export interface CodexAuth {
  accessToken: string;
  accountId: string;
  planType: string | null;
}

export interface CodexSignIn {
  /** OpenAI's sign-in page. Its redirect goes to Codex's own listener on this computer. */
  url: string;
  /** Resolves once the owner approved in the browser and Codex saved the sign-in. */
  done: Promise<void>;
  /** For a browser on another computer, where the localhost redirect cannot load: the address it ended on, opened here instead. */
  finish(callbackUrl: string): Promise<void>;
  cancel(): void;
}

export interface CodexCli {
  /** The binary in use, or null when there is none. */
  bin(): string | null;
  signIn(): Promise<CodexSignIn>;
  /** The account Dorks is signed in with (from the saved id token), or null. Reads a file only. */
  account(): { email: string | null; plan: string | null } | null;
  /** A current access token, refreshed first when it is about to expire or `force`d. Null when not signed in. */
  tokens(force?: boolean): Promise<CodexAuth | null>;
  signOut(): void;
}

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `DORKS_CODEX_BIN`, else `codex` on PATH (or the usual install dirs). */
export function findCodex(pathVar: string | undefined, configured: string | undefined): string | null {
  if (configured) return executable(configured) ? configured : null;
  for (const d of [...(pathVar ?? "").split(delimiter).filter(Boolean), ...EXTRA_DIRS]) if (executable(join(d, "codex"))) return join(d, "codex");
  return null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** A JWT's claims, unverified: only for this computer's own saved sign-in (expiry, account, email). */
export function jwtClaims(token: string): Json {
  try {
    return obj(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

const AUTH_CLAIMS = "https://api.openai.com/auth";

/** Codex's saved sign-in (`auth.json`): its tokens, or null when it has none. */
export function readSavedAuth(home: string): { access: string; accountId: string; id: string } | null {
  try {
    const tokens = obj(obj(JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))).tokens);
    const access = str(tokens.access_token);
    const accountId = str(tokens.account_id) ?? str(obj(jwtClaims(access ?? "")[AUTH_CLAIMS]).chatgpt_account_id);
    return access && accountId ? { access, accountId, id: str(tokens.id_token) ?? "" } : null;
  } catch {
    return null;
  }
}

/** One short-lived `codex app-server` on Dorks' Codex home: requests, notifications, and the end. */
function appServer(bin: string, home: string, env: NodeJS.ProcessEnv) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const child = spawn(bin, ["app-server", "--listen", "stdio://"], {
    cwd: home,
    env: { ...env, CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_API_KEY: "" },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let id = 0;
  let buf = "";
  const waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(method: string, params: Json) => void>();
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (s: string) => {
    buf += s;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m: Json;
      try {
        m = obj(JSON.parse(line));
      } catch {
        continue;
      }
      if (typeof m.method === "string" && m.id === undefined) for (const l of listeners) l(m.method, obj(m.params));
      else if (typeof m.id === "number" && m.method === undefined) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w?.reject(new CodexCliError(str(obj(m.error).message) ?? "Codex refused the request."));
        else w?.resolve(obj(m.result));
      }
    }
  });
  const ended = new Promise<void>((resolve) => child.on("close", () => resolve()));
  child.on("error", () => {});
  void ended.then(() => {
    for (const w of waiting.values()) w.reject(new CodexCliError("The Codex CLI stopped."));
    waiting.clear();
  });
  const request = (method: string, params: Json = {}) =>
    new Promise<Json>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        waiting.delete(n);
        reject(new CodexCliError(`Codex did not answer ${method}.`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      waiting.set(n, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`);
    });
  const open = async () => {
    await request("initialize", { clientInfo: { name: "dorks", title: "Dorks", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  };
  return { request, open, on: (l: (method: string, params: Json) => void) => listeners.add(l), close: () => child.kill(), ended };
}

export function makeCodexCli(o: { configured?: string; dataDir: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }): CodexCli {
  const env = o.env ?? process.env;
  const get = o.fetch ?? fetch;
  const home = join(o.dataDir, "codex");
  const bin = () => findCodex(env.PATH, o.configured);
  const need = () => {
    const b = bin();
    if (!b) throw new CodexCliError("Install the Codex CLI on this computer first (npm install -g @openai/codex), then sign in again.");
    return b;
  };
  let refreshing: Promise<CodexAuth | null> | null = null;

  /** Codex refreshes its own saved sign-in when asked to read the account with a refresh. */
  const refresh = async (): Promise<void> => {
    const server = appServer(need(), home, env);
    try {
      await server.open();
      await server.request("account/read", { refreshToken: true });
    } finally {
      server.close();
    }
  };

  const current = (): CodexAuth | null => {
    const saved = readSavedAuth(home);
    if (!saved) return null;
    const plan = str(obj(jwtClaims(saved.access)[AUTH_CLAIMS]).chatgpt_plan_type);
    return { accessToken: saved.access, accountId: saved.accountId, planType: plan };
  };

  return {
    bin,
    async signIn() {
      return startSignIn(appServer(need(), home, env), get);
    },
    account() {
      const saved = readSavedAuth(home);
      if (!saved) return null;
      const claims = jwtClaims(saved.id);
      return { email: str(claims.email), plan: str(obj(claims[AUTH_CLAIMS]).chatgpt_plan_type) ?? str(obj(jwtClaims(saved.access)[AUTH_CLAIMS]).chatgpt_plan_type) };
    },
    tokens(force = false) {
      const now = current();
      if (!now) return Promise.resolve(null);
      const exp = Number(jwtClaims(now.accessToken).exp ?? 0);
      if (!force && exp - Date.now() / 1000 > REFRESH_MARGIN_S) return Promise.resolve(now);
      // One refresh at a time: two boxes asking at once share it, and the refresh token rotates once.
      refreshing ??= refresh()
        .then(current)
        .finally(() => (refreshing = null));
      return refreshing;
    },
    signOut() {
      rmSync(join(home, "auth.json"), { force: true });
    },
  };
}

/** `account/login/start` (`chatgpt`): OpenAI's page, then the `account/login/completed` that says Codex saved the sign-in. */
async function startSignIn(server: ReturnType<typeof appServer>, get: typeof fetch): Promise<CodexSignIn> {
  let loginId: string | null = null;
  let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => {});
  const timer = setTimeout(() => settle?.reject(new CodexCliError("The ChatGPT sign-in timed out.")), SIGN_IN_TIMEOUT_MS);
  timer.unref();
  server.on((method, p) => {
    if (method !== "account/login/completed" || (loginId && p.loginId && p.loginId !== loginId)) return;
    if (p.success === true) settle?.resolve();
    else settle?.reject(new CodexCliError(str(p.error) ?? "The ChatGPT sign-in did not finish."));
  });
  void server.ended.then(() => settle?.reject(new CodexCliError("The Codex CLI stopped before the sign-in finished.")));
  void done
    .finally(() => {
      clearTimeout(timer);
      server.close();
    })
    .catch(() => {});
  let started: Json;
  try {
    await server.open();
    started = await Promise.race([
      server.request("account/login/start", { type: "chatgpt" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new CodexCliError("Codex did not start the ChatGPT sign-in.")), LINK_TIMEOUT_MS).unref()),
    ]);
  } catch (e) {
    server.close();
    throw e instanceof CodexCliError ? e : new CodexCliError("Codex did not start the ChatGPT sign-in.");
  }
  loginId = str(started.loginId);
  const url = str(started.authUrl);
  if (!url?.startsWith("https://")) {
    server.close();
    throw new CodexCliError("Codex did not start the ChatGPT sign-in.");
  }
  const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "http://invalid");
  return {
    url,
    done,
    async finish(callbackUrl: string) {
      let at: URL;
      try {
        at = new URL(callbackUrl.trim());
      } catch {
        throw new CodexCliError("Paste the whole address from the browser’s address bar.");
      }
      // Only Codex's own listener, on the port this sign-in opened: the server never fetches anything else for the owner.
      if (at.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(at.hostname) || at.port !== redirect.port || at.pathname !== redirect.pathname || !at.searchParams.get("code"))
        throw new CodexCliError("That isn’t the address the ChatGPT sign-in ended on.");
      await get(`http://127.0.0.1:${at.port}${at.pathname}${at.search}`, { redirect: "manual" }).catch(() => {
        throw new CodexCliError("The sign-in on this computer is no longer waiting. Start it again.");
      });
    },
    cancel: () => {
      settle?.reject(new CodexCliError("Cancelled."));
      server.close();
    },
  };
}
