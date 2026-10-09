const REPO = /^[\w.-]+\/[\w.-]+$/;

/** `owner/name` where neither side is `.` or `..` (the repo ends up in clone URLs and API paths). */
export const validRepo = (repo: string) => REPO.test(repo) && repo.split("/").every((seg) => seg !== "." && seg !== "..");

/** GitHub repo names are case-insensitive, so everything that is stored or matched by repo uses the lowercase form. */
export const normalizeRepo = (repo: string) => repo.toLowerCase();

export const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;
