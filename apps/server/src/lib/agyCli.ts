import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The Antigravity CLI (`agy`) on this computer, for one thing: signing the owner in to their Google AI plan without a terminal
// (services/antigravitySignIn.ts). Dorks never talks to Google's OAuth itself: it runs agy's own sign-in through `agy acp` (the
// Agent Client Protocol, JSON-RPC on stdio), whose `authenticate` method opens Google's consent page and catches the redirect on
// a localhost port of its own. The browser opener is a stub that hands the link to the server, which shows it in the app.
// The sign-in runs in a throwaway home, so agy writes its token to a file (no keyring there); the server stores that file
// encrypted and every sandbox gets it back (infra/bridge/src/antigravity.ts).

const EXTRA_DIRS = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const LINK_TIMEOUT_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;

export class AgyCliError extends Error {}

export interface AgySignIn {
  /** Google's consent page. Its redirect goes to agy's own listener on this computer. */
  url: string;
  /** Resolves with agy's token file (JSON) once the owner approved in the browser. */
  done: Promise<string>;
  /**
   * For a browser on another computer, where the localhost redirect cannot load: the address it ended on, which the server opens
   * here instead.
   */
  finish(callbackUrl: string): Promise<void>;
  cancel(): void;
}

export interface AgyCli {
  /** The binary in use, or null when there is none yet (`install` fetches one). */
  bin(): string | null;
  /** Downloads Google's current build into the data dir, checksum-verified. Returns its path. */
  install(): Promise<string>;
  signIn(): Promise<AgySignIn>;
}

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `DORKS_AGY_BIN`, else `agy` on PATH (or Google's install dir), else the copy Dorks downloaded into its data dir. */
export function findAgy(pathVar: string | undefined, configured: string | undefined, dataDir: string): string | null {
  if (configured) return executable(configured) ? configured : null;
  const dirs = [...(pathVar ?? "").split(delimiter).filter(Boolean), ...EXTRA_DIRS, join(dataDir, "bin")];
  for (const d of dirs) if (executable(join(d, "agy"))) return join(d, "agy");
  return null;
}

/** The manifest's platform name (the one Google's install.sh uses). */
function platform(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!os || !arch) throw new AgyCliError("The Antigravity CLI isn’t available for this computer.");
  return `${os}_${arch}`;
}

const field = (raw: string, key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(raw)?.[1];

export function makeAgyCli(o: { configured?: string; dataDir: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }): AgyCli {
  const env = o.env ?? process.env;
  const get = o.fetch ?? fetch;
  let installing: Promise<string> | null = null;

  const install = async (): Promise<string> => {
    const dir = join(o.dataDir, "bin");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest = await (await get(`${MANIFESTS}/${platform()}.json`)).text();
    const url = field(manifest, "url");
    const sha512 = field(manifest, "sha512");
    if (!url?.startsWith("https://") || !sha512) throw new AgyCliError("Could not read the Antigravity CLI release manifest.");
    const res = await get(url);
    if (!res.ok) throw new AgyCliError(`Could not download the Antigravity CLI (${res.status}).`);
    const body = Buffer.from(await res.arrayBuffer());
    if (createHash("sha512").update(body).digest("hex") !== sha512) throw new AgyCliError("The Antigravity CLI download did not match its checksum.");
    const work = mkdtempSync(join(dir, ".agy-"));
    try {
      if (url.includes(".tar.gz")) {
        writeFileSync(join(work, "pkg.tar.gz"), body);
        await new Promise<void>((resolve, reject) => execFile("tar", ["-xzf", join(work, "pkg.tar.gz"), "-C", work, "antigravity"], (e) => (e ? reject(e) : resolve())));
        renameSync(join(work, "antigravity"), join(work, "agy"));
      } else writeFileSync(join(work, "agy"), body);
      chmodSync(join(work, "agy"), 0o755);
      renameSync(join(work, "agy"), join(dir, "agy"));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    return join(dir, "agy");
  };

  const bin = () => findAgy(env.PATH, o.configured, o.dataDir);

  return {
    bin,
    install: () => (installing ??= install().finally(() => (installing = null))),
    async signIn() {
      const agy = bin() ?? (await install());
      return startSignIn(agy, env, get);
    },
  };
}

/** `agy acp`, `initialize` then `authenticate` with Google, the browser opener replaced by a stub that writes the link to a file. */
async function startSignIn(agy: string, env: NodeJS.ProcessEnv, get: typeof fetch): Promise<AgySignIn> {
  const root = mkdtempSync(join(tmpdir(), "dorks-agy-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const stubs = join(root, "bin");
  const linkFile = join(root, "link");
  mkdirSync(home);
  mkdirSync(stubs);
  const opener = `#!/bin/sh\nfor a; do u="$a"; done\nprintf '%s' "$u" > '${linkFile}'\n`;
  for (const name of ["open", "xdg-open"]) writeFileSync(join(stubs, name), opener, { mode: 0o755 });
  const [cmd, args] = withoutKeychain(agy, ["acp"]);
  const child = spawn(cmd, args, {
    cwd: home,
    env: {
      ...env,
      HOME: home,
      PATH: `${stubs}${delimiter}${env.PATH ?? ""}`,
      BROWSER: join(stubs, "open"),
      // No keyring: agy keeps the sign-in in its token file, which is what Dorks carries to the sandboxes.
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/dorks-no-keyring",
    },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let ended = false;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    child.kill();
    rmSync(root, { recursive: true, force: true });
  };
  child.stdin.on("error", () => {});
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);

  const done = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgyCliError("The Google sign-in timed out.")), SIGN_IN_TIMEOUT_MS);
    timer.unref();
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== 2) continue;
        if (m.error) return reject(new AgyCliError(m.error.message || "The Google sign-in did not finish."));
        void tokenFile(home).then(resolve, reject);
      }
    });
    child.on("close", () => reject(new AgyCliError("The Antigravity CLI stopped before the sign-in finished.")));
    child.on("error", () => reject(new AgyCliError("The Antigravity CLI could not start.")));
  }).finally(() => cleanup());
  done.catch(() => {});

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "dorks", version: "1" } } });
  send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "oauth-personal" } });

  const url = await waitFor(() => (existsSync(linkFile) ? readFileSync(linkFile, "utf8").trim() : null), LINK_TIMEOUT_MS, done);
  if (!url || !url.startsWith("https://accounts.google.com/")) {
    cleanup();
    throw new AgyCliError("The Antigravity CLI did not start the Google sign-in.");
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
        throw new AgyCliError("Paste the whole address from the browser’s address bar.");
      }
      // Only agy's own listener, on the port this sign-in opened: the server never fetches anything else for the owner.
      if (at.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(at.hostname) || at.port !== redirect.port || at.pathname !== redirect.pathname || !at.searchParams.get("code"))
        throw new AgyCliError("That isn’t the address the Google sign-in ended on.");
      await get(at.toString(), { redirect: "manual" }).catch(() => {
        throw new AgyCliError("The sign-in on this computer is no longer waiting. Start it again.");
      });
    },
    cancel: cleanup,
  };
}

/**
 * macOS: agy saves its sign-in with `/usr/bin/security`, which, in a home with no keychain, stops on a "Keychain Not Found" dialog.
 * Run under a sandbox that may not start that one tool: the write fails at once and agy keeps its token file, the one Dorks uses.
 * Nothing else is restricted. Linux needs nothing: the unreachable D-Bus above already rules the keyring out.
 */
export function withoutKeychain(bin: string, args: string[], sandboxExec = "/usr/bin/sandbox-exec"): [string, string[]] {
  if (process.platform !== "darwin" || !existsSync(sandboxExec)) return [bin, args];
  return [sandboxExec, ["-p", '(version 1)(allow default)(deny process-exec (literal "/usr/bin/security"))', bin, ...args]];
}

/** agy may try a keyring before it falls back to its file (a few seconds on macOS): wait for the file. */
async function tokenFile(home: string): Promise<string> {
  const file = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const raw = await waitFor(() => (existsSync(file) ? readFileSync(file, "utf8") : null), 20_000);
  if (!raw) throw new AgyCliError("Signed in, but the Antigravity CLI kept no token Dorks can use.");
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (!parsed.token) throw new Error("no token");
  } catch {
    throw new AgyCliError("The Antigravity CLI saved a token Dorks does not understand.");
  }
  return raw.trim();
}

async function waitFor<T>(read: () => T | null, ms: number, abort?: Promise<unknown>): Promise<T | null> {
  let stopped = false;
  abort?.then(
    () => (stopped = true),
    () => (stopped = true),
  );
  const until = Date.now() + ms;
  while (Date.now() < until && !stopped) {
    const v = read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return read();
}
