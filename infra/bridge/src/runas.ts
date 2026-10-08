import { execFileSync } from "node:child_process";

/**
 * Optional privilege separation (`CLAUDE_RUN_AS=<user>`). The bridge keeps its own uid (typically root in the box) and runs Claude, and the
 * git commands that prepare its working tree, as this unprivileged user. That is the only real protection for BRIDGE_SECRET: another
 * uid cannot read the bridge's /proc/<pid>/environ or /proc/<pid>/mem, whereas a child of the same uid can.
 */
export interface Identity {
  user: string;
  uid: number;
  gid: number;
  home: string;
}

export function resolveIdentity(user: string): Identity {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) throw new Error("CLAUDE_RUN_AS needs the bridge to run as root (it drops privileges for the child with setpriv)");
  const out = (cmd: string, ...a: string[]) => execFileSync(cmd, a, { encoding: "utf8" }).trim();
  try {
    const [, , uid, gid, , home] = out("getent", "passwd", user).split(":");
    if (!uid || !gid) throw new Error("no such user");
    return { user, uid: Number(uid), gid: Number(gid), home: home || "/" };
  } catch {
    throw new Error(`CLAUDE_RUN_AS: user "${user}" not found`);
  }
}

/** argv prefix that execs `cmd` as the identity, with its supplementary groups. */
export function asIdentity(id: Identity | null | undefined, cmd: string, args: string[]): [string, string[]] {
  if (!id) return [cmd, args];
  return ["setpriv", [`--reuid=${id.uid}`, `--regid=${id.gid}`, "--init-groups", "--", cmd, ...args]];
}
