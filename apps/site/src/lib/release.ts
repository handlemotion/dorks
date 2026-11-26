/**
 * The Mac app's GitHub releases (`desktop-v<version>`, published by .github/workflows/desktop-release.yml), read by the
 * edge Worker for /download and by the site's build for the version and size shown under the download buttons.
 */
export const REPO = "handlemotion/dorks";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
/** Shown under every download button. Keep in step with tauri.conf.json (minimumSystemVersion) and the release target. */
export const REQUIREMENTS = "macOS 12 or later · Apple silicon";
/** The hero's one short line: "v0.13.0 · macOS 12+". */
export const SHORT_REQUIREMENTS = "macOS 12+";

export interface MacRelease {
  version: string;
  /** The .dmg's direct download URL (github.com/.../releases/download/...). */
  url: string;
  name: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  assets: { name: string; size: number; browser_download_url: string }[];
}

/** `0.12.1`, `v0.12.1` and `desktop-v0.12.1` all name the same release; anything else is not a version. */
export function parseVersion(value: string): string | null {
  const match = /^(?:desktop-)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(value);
  return match ? match[1] : null;
}

/** `version` is a version or "latest". null when GitHub has no such published release or it carries no .dmg. Throws when GitHub can't be reached. */
export async function fetchMacRelease(version: string): Promise<MacRelease | null> {
  const path = version === "latest" ? "releases/latest" : `releases/tags/desktop-v${version}`;
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "dorks.build", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
  const release = (await response.json()) as GitHubRelease;
  const releaseVersion = parseVersion(release.tag_name);
  // Prefer the dorks-v<version>.dmg name; earlier releases were named Dorks_<version>_aarch64.dmg.
  const dmg = release.assets.find((a) => a.name === `dorks-v${releaseVersion}.dmg`) ?? release.assets.find((a) => a.name.endsWith(".dmg"));
  if (release.draft || !releaseVersion || !dmg) return null;
  return { version: releaseVersion, url: dmg.browser_download_url, name: dmg.name, size: dmg.size };
}

/** "34 MB" */
export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
