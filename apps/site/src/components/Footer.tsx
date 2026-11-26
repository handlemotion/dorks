import { Button } from "#/components/ui/button";
import type { MacRelease } from "#/lib/release";
import { DOWNLOAD_URL, DownloadDetails, downloadTitle, useMacRelease } from "./Download";

export function Footer({ release: built }: { release: MacRelease | null }) {
  const release = useMacRelease(built);
  return (
    <footer className="w-full bg-white px-5 py-16 text-neutral-950 sm:px-12">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col items-start justify-between gap-8 sm:flex-row sm:items-center">
        <p className="font-serif text-2xl">Get Dorks for your Mac.</p>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Button variant="solidDark" size="default" nativeButton={false} title={downloadTitle(release)} render={<a href={DOWNLOAD_URL} />}>
            Download for Mac
          </Button>
          <DownloadDetails release={release} className="text-neutral-500" />
        </div>
      </div>
    </footer>
  );
}
