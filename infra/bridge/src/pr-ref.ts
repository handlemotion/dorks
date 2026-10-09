import type { PrRef } from "@dorks/shared";

// PR references as people and tools write them. Pure, so the short-lived commands (`dorks`, the gh shim) stay light.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?![\d])/g;
const SHORT_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})$/;

export const validRepo = (repo: string) => REPO.test(repo) && !repo.split("/").some((p) => p === "." || p === "..");

export function toRef(repo: string | undefined, number: string | number | undefined): PrRef | null {
  const n = Number(number);
  return repo && validRepo(repo) && Number.isInteger(n) && n > 0 ? { repo, number: n } : null;
}

/** `https://github.com/owner/name/pull/12` (a trailing path, query or fragment is fine) or `owner/name#12`. */
export function parsePrRef(input: string): PrRef | null {
  const s = input.trim();
  const short = SHORT_REF.exec(s);
  if (short) return toRef(short[1], short[2]);
  if (!/^https?:\/\//.test(s)) return null;
  const url = [...s.matchAll(PR_URL)];
  return url.length === 1 && url[0]!.index === 0 ? toRef(url[0]![1], url[0]![2]) : null;
}

/** Every distinct PR URL in a piece of text (command output), in order of appearance. */
export function findPrUrls(text: string): PrRef[] {
  const seen = new Set<string>();
  const out: PrRef[] = [];
  for (const m of text.matchAll(PR_URL)) {
    const ref = toRef(m[1], m[2]);
    if (ref && !seen.has(`${ref.repo}#${ref.number}`)) {
      seen.add(`${ref.repo}#${ref.number}`);
      out.push(ref);
    }
  }
  return out;
}

export const prLabel = (r: PrRef) => `${r.repo}#${r.number}`;

/** The backend stores `repo` lowercase (GitHub names are case-insensitive), while URLs and remotes keep the author's casing. */
export const samePr = (a: PrRef, b: PrRef) => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
