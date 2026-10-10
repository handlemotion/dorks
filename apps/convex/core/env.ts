// Which variables a dork's sandbox gets (docs/snapshots.md, "Per-repo environments").
//
// Variables are set per repo, or account-wide as a default. A dork of `owner/name` gets the account-wide ones plus its own repo's; where a
// name is in both, the repo's value wins. Variables of other repos never reach it.

export type ScopedSecret = { name: string; repo?: string | null; valueEnc: string };

/** The variables for a dork of `repo` (any casing), one per name, repo-scoped over account-wide. */
export function pickSecrets<T extends ScopedSecret>(secrets: T[], repo: string): T[] {
  const mine = repo.toLowerCase();
  const byName = new Map<string, T>();
  for (const s of secrets) if (!s.repo) byName.set(s.name, s);
  for (const s of secrets) if (s.repo && s.repo === mine) byName.set(s.name, s);
  return [...byName.values()];
}
