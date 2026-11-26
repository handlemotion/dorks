import { useEffect, useState } from "react";
import { formatSize, REQUIREMENTS, SHORT_REQUIREMENTS, type MacRelease } from "#/lib/release";
import { cn } from "#/lib/utils";

/** Every download button links here: the edge Worker redirects it to the latest .dmg (src/worker.ts). */
export const DOWNLOAD_URL = "/download";

let latest: Promise<MacRelease | null> | undefined;

/**
 * The latest release: the one the site was built with, then the Worker's current answer (/download.json), since a release
 * doesn't rebuild the site.
 */
export function useMacRelease(built: MacRelease | null): MacRelease | null {
  const [release, setRelease] = useState(built);
  useEffect(() => {
    latest ??= fetch("/download.json")
      .then((r) => (r.ok ? (r.json() as Promise<MacRelease>) : null))
      .catch(() => null);
    let live = true;
    void latest.then((r) => {
      if (live && r?.version) setRelease(r);
    });
    return () => {
      live = false;
    };
  }, []);
  return release;
}

/** "v0.12.1 · 35 MB" */
export function releaseLabel(release: MacRelease | null): string | null {
  return release ? `v${release.version} · ${formatSize(release.size)}` : null;
}

/** The line under a download button: version, size and what it runs on; `short` is just the version and macOS. */
export function DownloadDetails({ release, short, className }: { release: MacRelease | null; short?: boolean; className?: string }) {
  const label = short ? (release ? `v${release.version}` : null) : releaseLabel(release);
  return (
    <p className={cn("text-[13px] leading-[1.4]", className)}>
      {label ? <span className="tabular-nums">{label} · </span> : null}
      {short ? SHORT_REQUIREMENTS : REQUIREMENTS}
    </p>
  );
}

export function downloadTitle(release: MacRelease | null): string {
  return release ? `Download Dorks ${release.version} for Mac (${formatSize(release.size)})` : "Download Dorks for Mac";
}
