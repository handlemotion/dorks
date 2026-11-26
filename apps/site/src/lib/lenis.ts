import Lenis from "lenis";

type ScrollListener = (scroll: number) => void;

let instance: Lenis | null = null;
const listeners = new Set<ScrollListener>();
let initialized = false;

export function getLenis(): Lenis | null {
  if (typeof window === "undefined") return null;
  if (initialized) return instance;
  initialized = true;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return null;

  instance = new Lenis({
    autoRaf: true,
    lerp: 0.1,
  });

  instance.on("scroll", ({ scroll }) => {
    for (const listener of listeners) {
      listener(scroll);
    }
  });

  window.addEventListener("pagehide", () => {
    instance?.destroy();
    instance = null;
    initialized = false;
  });

  return instance;
}

export function subscribeLenisScroll(listener: ScrollListener): () => void {
  const lenis = getLenis();
  if (!lenis) return () => {};

  listeners.add(listener);
  listener(lenis.scroll);

  return () => {
    listeners.delete(listener);
  };
}
