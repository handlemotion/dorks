import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

// The Boat CLI on this computer (docs/boat.md, "Sign in with the Boat CLI"). Dorks signs in to Boat the way it signs in to GitHub:
// through the owner's own CLI login. With `boat` signed in, the server makes itself a scoped API key (`boat api-key create`) and
// reads the organization new sandboxes bill to (`boat org status`); signed out, it runs `boat login --wait`, which hands back a
// browser link and returns once the owner finished signing in. The CLI's session file is its own business: Dorks only runs it.
//
// Which `boat`: the one on PATH (or where its installer puts it), else the copy bundled with the desktop app (`DORKS_BOAT_BIN`).
// Every call runs with `BOAT_NO_UPDATE=1`: the CLI updates itself otherwise, which would rewrite a signed binary inside the app.

const EXTRA_DIRS = [join(homedir(), ".ascii", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const TIMEOUT_MS = 30_000;

/**
 * What Dorks' own key may do: everything it does with sandboxes, snapshots and environments, plus `account.read` for the plan
 * check, and nothing that administers the account. Plain `sandbox.delete` rather than `-own`, so a key made after a reconnect can
 * still delete the sandboxes an earlier key created.
 */
export const KEY_ACTIONS = [
  "sandbox.create",
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.resume",
  "sandbox.fork",
  "sandbox.delete",
  "agent.prompt",
  "exec",
  "file.read",
  "file.write",
  "ssh",
  "desktop",
  "host",
  "snapshot.read",
  "snapshot.write",
  "environment.read",
  "account.read",
] as const;

export interface BoatSignIn {
  url: string;
  /** The code the browser may ask for. */
  userCode?: string;
  expiresAt?: string;
}

/** The calls Dorks makes to the Boat CLI. Tests replace it (App.boatCli). */
export interface BoatCli {
  /** The binary in use, or null when there is none. */
  bin: string | null;
  signedIn(): Promise<boolean>;
  /** The organization new sandboxes bill to (`boat org status`), null for the personal account. */
  org(): Promise<string | null>;
  createKey(name: string): Promise<{ id: string; secret: string }>;
  revokeKey(id: string): Promise<void>;
  /** Starts `boat login --wait`: resolves with the link as soon as the CLI prints it; `done` settles when the sign-in ends. */
  login(): Promise<{ link: BoatSignIn; done: Promise<void> }>;
}

export class BoatCliError extends Error {
  override name = "BoatCliError";
}

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `boat` on PATH or in its usual install directories, else the bundled one. */
export function findBoat(pathVar: string | undefined, bundled: string | undefined): string | null {
  const dirs = [...(pathVar ? pathVar.split(delimiter) : []), ...EXTRA_DIRS].filter(Boolean);
  for (const dir of dirs) if (executable(join(dir, "boat"))) return join(dir, "boat");
  return bundled && executable(bundled) ? bundled : null;
}

const cliEnv = (env: NodeJS.ProcessEnv) => ({ ...env, BOAT_NO_UPDATE: "1", NO_COLOR: "1" });

/** The CLI's JSON lines, last first: the answer is the last line it printed. */
const jsonLines = (out: string): Record<string, unknown>[] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .reverse();

/** The message of a JSON error line (`{"event":"error","error":"..."}`), or a plain one. Never includes stdout, which can hold a key. */
const errorOf = (out: string, fallback: string) => {
  const e = jsonLines(out).find((l) => l.event === "error" && typeof l.error === "string");
  return new BoatCliError(e ? String(e.error) : fallback);
};

export function makeBoatCli(bin: string | null, env: NodeJS.ProcessEnv = process.env): BoatCli {
  const run = (args: string[]) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!bin) return reject(new BoatCliError("The Boat CLI isn’t installed."));
      execFile(bin, [...args, "--json"], { env: cliEnv(env), timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        const out = String(stdout);
        if (err) return reject(errorOf(out, `boat ${args[0]} failed`));
        const last = jsonLines(out)[0];
        if (!last || last.event === "error") return reject(errorOf(out, `boat ${args[0]} printed no answer`));
        resolve(last);
      });
    });

  return {
    bin,
    signedIn: async () => {
      const s = await run(["status"]);
      const account = s.account as { signedIn?: unknown } | undefined;
      return account?.signedIn === true;
    },
    org: async () => {
      const s = await run(["org", "status"]);
      return typeof s.org === "string" && s.org ? s.org : null;
    },
    createKey: async (name) => {
      const r = await run(["api-key", "create", name, "--ttl", "never", "--actions", KEY_ACTIONS.join(",")]).catch((e: unknown) => {
        // `boat login <key>` signs the CLI in with a key, which can make keys only if it is an admin one.
        if (e instanceof BoatCliError && /account\.admin/.test(e.message))
          throw new BoatCliError("The Boat CLI is signed in with an API key that can’t make keys. Run `boat login` to sign in with your account, or add a key in Settings.");
        throw e;
      });
      const secret = r.secret;
      const id = (r.apiKey as { id?: unknown } | undefined)?.id;
      if (typeof secret !== "string" || !secret || typeof id !== "string") throw new BoatCliError("boat api-key create returned no key");
      return { id, secret };
    },
    revokeKey: async (id) => {
      await run(["api-key", "revoke", id]);
    },
    login: () =>
      new Promise((resolve, reject) => {
        if (!bin) return reject(new BoatCliError("The Boat CLI isn’t installed."));
        // `--new`: with a link left pending (a sign-in that was abandoned), plain `--wait` prints nothing and waits on that one.
        const child = spawn(bin, ["login", "--wait", "--new", "--json"], { env: cliEnv(env), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let linked = false;
        let finished = false;
        let failure: string | undefined;
        const done = new Promise<void>((ok, fail) => {
          child.on("error", (e) => {
            if (!linked) reject(new BoatCliError(`could not run boat: ${e.message}`));
            fail(new BoatCliError(e.message));
          });
          child.on("close", (code) => {
            if (!linked) reject(new BoatCliError(failure ?? "boat login printed no sign-in link"));
            if (finished || code === 0) ok();
            else fail(new BoatCliError(failure ?? "The Boat sign-in did not finish."));
          });
        });
        done.catch(() => {}); // the caller attaches its own handler once it has the link
        createInterface({ input: child.stdout }).on("line", (line) => {
          const [ev] = jsonLines(line);
          if (!ev) return;
          if (ev.event === "error" && typeof ev.error === "string") failure = ev.error;
          if (ev.event === "login_complete") finished = true;
          // `login_url` (a new link) or `login_pending` (the link a previous run started, still valid).
          if (!linked && typeof ev.url === "string" && (ev.event === "login_url" || ev.event === "login_pending")) {
            linked = true;
            resolve({
              link: { url: ev.url, userCode: typeof ev.userCode === "string" ? ev.userCode : undefined, expiresAt: typeof ev.expiresAt === "string" ? ev.expiresAt : undefined },
              done,
            });
          }
        });
        // A sign-in that is never finished: the CLI gives up at the link's expiry; this is only a backstop.
        setTimeout(() => child.kill(), 20 * 60_000).unref();
      }),
  };
}
