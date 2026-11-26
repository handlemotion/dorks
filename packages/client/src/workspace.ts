import type { CloudUser } from "./types.ts";

/**
 * The personal org's label, from the account: "Rodrigo’s Workspace" from the first name, else from the email's local part
 * ("rodrigo.m@…" reads "Rodrigo’s Workspace"). A name that is only the email counts as no name. Names ending in s get "’s" too
 * ("James’s"). The relay names every personal org "Personal"; this is what people see instead.
 */
export function personalWorkspaceName(user: Pick<CloudUser, "name" | "email"> | null | undefined): string | null {
  if (!user) return null;
  const name = user.name?.trim() ?? "";
  const first = name && !name.includes("@") ? name.split(/\s+/)[0] : "";
  const local =
    (user.email ?? "")
      .split("@")[0]
      .split(/[._+-]/)
      .find(Boolean) ?? "";
  const who = first || (local ? local[0].toUpperCase() + local.slice(1) : "");
  return who ? `${who}’s Workspace` : null;
}
