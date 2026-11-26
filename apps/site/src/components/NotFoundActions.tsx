import { Button } from "#/components/ui/button";
import type { MacRelease } from "#/lib/release";
import { DOWNLOAD_URL, DownloadDetails, downloadTitle, useMacRelease } from "./Download";

export function NotFoundActions({ release: built }: { release: MacRelease | null }) {
  const release = useMacRelease(built);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Button variant="solid" size="default" nativeButton={false} title={downloadTitle(release)} render={<a href={DOWNLOAD_URL} />}>
          Download for Mac
        </Button>
        <Button variant="glass" size="default" nativeButton={false} render={<a href="/" />}>
          Go to dorks.build
        </Button>
      </div>
      <DownloadDetails release={release} className="text-white/80" />
    </div>
  );
}
