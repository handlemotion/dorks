import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu";
import { getLenis, subscribeLenisScroll } from "#/lib/lenis";
import { formatSize, RELEASES_URL, type MacRelease } from "#/lib/release";
import { cn } from "#/lib/utils";
import { DOWNLOAD_URL, DownloadDetails, downloadTitle, useMacRelease } from "./Download";

const GITHUB_URL = "https://github.com/handlemotion/dorks";
const LOGIN_URL = "https://app.dorks.build";

function DorksMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none" aria-hidden="true" className={className}>
      <path
        d="M180 40c0-22.091-35.817-40-80-40S20 17.909 20 40c0 11.947 10.475 22.67 27.084 30C30.474 77.33 20 88.053 20 100s10.475 22.671 27.084 30C30.474 137.329 20 148.053 20 160c0 22.091 35.817 40 80 40s80-17.909 80-40c0-11.947-10.475-22.671-27.084-30C169.525 122.671 180 111.947 180 100s-10.475-22.67-27.084-30C169.525 62.67 180 51.947 180 40"
        fill="currentColor"
      />
    </svg>
  );
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="16" viewBox="0 0 14 17" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M11.66 8.95c-.02-1.88 1.54-2.79 1.61-2.83-.88-1.29-2.25-1.46-2.73-1.48-1.15-.12-2.27.69-2.86.69-.6 0-1.5-.67-2.47-.65-1.26.02-2.43.74-3.08 1.87-1.33 2.3-.34 5.7.94 7.56.63.91 1.38 1.93 2.36 1.89.95-.04 1.31-.61 2.46-.61 1.14 0 1.47.61 2.46.59 1.02-.02 1.66-.92 2.28-1.84.73-1.05 1.02-2.08 1.04-2.13-.02-.01-1.99-.76-2.01-3.06ZM9.79 3.43c.52-.64.88-1.52.78-2.41-.76.03-1.69.51-2.23 1.14-.48.55-.91 1.46-.8 2.32.85.07 1.72-.43 2.25-1.05Z" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const navItems = [
  { label: "Cloud", href: "#cloud" },
  { label: "Pricing", href: "#pricing" },
  { label: "Docs", href: "/docs" },
];

const blurLayers = [
  {
    blur: "backdrop-blur-[2px]",
    mask: "linear-gradient(to bottom, black 0%, black 58%, transparent 100%)",
  },
  {
    blur: "backdrop-blur-[6px]",
    mask: "linear-gradient(to bottom, black 0%, black 44%, transparent 82%)",
  },
  {
    blur: "backdrop-blur-[12px]",
    mask: "linear-gradient(to bottom, black 0%, black 30%, transparent 64%)",
  },
  {
    blur: "backdrop-blur-[20px]",
    mask: "linear-gradient(to bottom, black 0%, black 16%, transparent 46%)",
  },
];

export function Hero({ release: built }: { release: MacRelease | null }) {
  const release = useMacRelease(built);
  const sectionRef = useRef<HTMLElement>(null);
  const bgRef = useRef<HTMLImageElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const graphicRef = useRef<HTMLDivElement>(null);
  const [onLightSurface, setOnLightSurface] = useState(false);

  useEffect(() => {
    const updateNavState = () => {
      const section = sectionRef.current;
      const graphic = graphicRef.current;
      const overGraphic = graphic ? graphic.getBoundingClientRect().top <= 56 : false;
      const pastHero = section ? section.getBoundingClientRect().bottom <= 56 : false;
      setOnLightSurface(overGraphic || pastHero);
    };

    const applyParallax = (scroll: number) => {
      const section = sectionRef.current;
      if (!section) return;

      const height = section.offsetHeight || window.innerHeight;
      const progress = Math.min(Math.max(scroll / height, 0), 1);

      if (bgRef.current) {
        bgRef.current.style.transform = `translate3d(0, ${(progress * 24).toFixed(2)}px, 0)`;
      }
      if (copyRef.current) {
        copyRef.current.style.transform = `translate3d(0, ${(progress * 44).toFixed(2)}px, 0)`;
        copyRef.current.style.opacity = (1 - progress * 0.72).toFixed(3);
      }
      if (graphicRef.current) {
        graphicRef.current.style.transform = `translate3d(0, ${(-progress * 68).toFixed(2)}px, 0)`;
      }

      updateNavState();
    };

    const unsubscribe = subscribeLenisScroll(applyParallax);
    const onNativeScroll = () => updateNavState();
    window.addEventListener("scroll", onNativeScroll, { passive: true });
    updateNavState();

    return () => {
      unsubscribe();
      window.removeEventListener("scroll", onNativeScroll);
    };
  }, []);

  const handleScrollToTop = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (window.location.pathname !== "/") return;
    event.preventDefault();
    const lenis = getLenis();
    if (lenis) {
      lenis.scrollTo(0);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 w-full items-center justify-between bg-transparent px-4 sm:px-6">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-32">
          {blurLayers.map((layer) => (
            <div
              key={layer.blur}
              className={cn("absolute inset-0", layer.blur)}
              style={{
                maskImage: layer.mask,
                WebkitMaskImage: layer.mask,
              }}
            />
          ))}
        </div>

        <a
          href="/"
          onClick={handleScrollToTop}
          aria-label="Scroll to top"
          className={cn(
            "relative z-10 inline-flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors duration-250 ease-out focus-visible:outline-none focus-visible:ring-2",
            onLightSurface ? "text-neutral-950 hover:bg-black/8 focus-visible:ring-black/30" : "text-white hover:bg-black/15 focus-visible:ring-white/75",
          )}
        >
          <DorksMark size={24} className="pointer-events-none" />
        </a>

        <nav aria-label="Primary" className="relative z-10 hidden items-center gap-2.5 sm:absolute sm:left-1/2 sm:flex sm:-translate-x-1/2">
          {navItems.map((item) => (
            <Button key={item.label} variant={onLightSurface ? "navLight" : "nav"} size="default" nativeButton={false} render={<a href={item.href} />}>
              {item.label}
            </Button>
          ))}
        </nav>

        <div className="relative z-10 flex items-center gap-2.5">
          <Button variant={onLightSurface ? "navLight" : "nav"} size="icon-sm" aria-label="GitHub" nativeButton={false} render={<a href={GITHUB_URL} target="_blank" rel="noreferrer" />}>
            <GitHubIcon />
          </Button>
          <Button variant={onLightSurface ? "navLight" : "nav"} size="sm" nativeButton={false} title={downloadTitle(release)} render={<a href={DOWNLOAD_URL} />}>
            <AppleIcon className="-mt-0.5" />
            <span>Download</span>
            {release ? (
              <span className="hidden tabular-nums opacity-70 md:inline">
                v{release.version} · {formatSize(release.size)}
              </span>
            ) : null}
          </Button>
          <Button variant={onLightSurface ? "solidDark" : "solid"} size="sm" nativeButton={false} render={<a href={LOGIN_URL} />}>
            Log In
          </Button>
        </div>
      </header>

      <section ref={sectionRef} className="relative flex min-h-[90svh] w-full flex-col overflow-hidden bg-[#b7a29e] text-white lg:h-[90svh] lg:min-h-[760px]">
        <img
          ref={bgRef}
          src="/hero-bg.webp"
          alt=""
          aria-hidden="true"
          width={1672}
          height={941}
          draggable={false}
          fetchPriority="high"
          className="pointer-events-none absolute -inset-y-6 inset-x-0 h-[calc(100%+48px)] w-full object-cover object-center will-change-transform select-none [-webkit-user-drag:none]"
        />

        <main className="relative z-10 mx-auto flex w-full flex-1 flex-col items-center px-5 pt-28 sm:px-12 sm:pt-[120px] lg:px-[clamp(64px,6.6vw,140px)]">
          <div ref={copyRef} className="relative z-0 flex w-full max-w-[568px] shrink-0 flex-col items-center gap-9 will-change-[transform,opacity]">
            <div className="flex w-full flex-col items-center gap-4 text-center">
              <DorksMark size={36} className="text-white" />
              <h1 className="font-serif text-[32px] font-normal leading-[1.3] tracking-normal text-white sm:text-[40px]">
                Dorks is the last ADE
                <br />
                you&rsquo;ll ever install.
              </h1>
            </div>

            <div className="flex flex-col items-center gap-3">
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <div className="inline-flex h-9 items-center rounded-full bg-white">
                  <Button variant="splitPrimary" size="splitMain" nativeButton={false} title={downloadTitle(release)} render={<a href={DOWNLOAD_URL} />}>
                    <AppleIcon className="-mt-0.5" />
                    <span>Download for Mac</span>
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="splitTrigger" size="splitEnd" aria-label="More download options" />}>
                      <ChevronDown className="size-3.5 stroke-[1.75]" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={8}>
                      <DropdownMenuItem render={<a href={DOWNLOAD_URL} />}>
                        <span>Apple silicon (.dmg)</span>
                        <span className="text-xs text-neutral-400 tabular-nums">{release ? formatSize(release.size) : "macOS"}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem render={<a href={RELEASES_URL} target="_blank" rel="noreferrer" />}>
                        <span>All releases</span>
                        <span className="text-xs text-neutral-400">GitHub</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem render={<a href="/docs/quickstart" />}>
                        <span>Quickstart guide</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <Button variant="glass" size="default" nativeButton={false} render={<a href={LOGIN_URL} />}>
                  Log In
                </Button>
              </div>
              <DownloadDetails release={release} className="text-white/90" />
            </div>
          </div>

          <div ref={graphicRef} className="relative z-10 mt-14 flex w-full flex-1 pb-10 will-change-transform sm:mt-[80px] lg:min-h-0 lg:pb-0">
            <img
              src="/hero-app.webp"
              alt="Dorks desktop workspace showing an agent session alongside a merged pull request"
              width={3360}
              height={2040}
              draggable={false}
              className="block h-auto w-full rounded-[10px] object-cover object-top select-none [-webkit-user-drag:none] lg:min-h-full lg:rounded-b-none"
            />
          </div>
        </main>
      </section>
    </>
  );
}
