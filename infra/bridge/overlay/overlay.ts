// The preview overlay: the script the preview proxy (src/preview-proxy.ts) adds to every page of a previewed dev server. The owner's
// app shows the page in a frame on another origin, so it cannot reach into it; this script does the element picking inside the page
// and talks to the app over postMessage. It does nothing unless the page is framed, and answers only its parent window.
//
// Protocol (every message carries `dorks`: "overlay" from here, "host" from the app):
//   overlay → host  {type: "ready"}                       on load, and in answer to "hello"
//                   {type: "hover", box | null}           the element under the pointer while picking, in the frame's viewport
//                   {type: "grab", snippet}               the picked element's context (React Grab's snippet: markup, component, source)
//                   {type: "picking", on: false}          picking ended here (a pick, or Escape)
//   host → overlay  {type: "hello"} | {type: "pick", on}
// The snippet is the page's own markup and source locations, which anyone with the (public) URL can read anyway, so replies go to
// the parent with targetOrigin "*".
import { getElementAtPoint, getElementBounds, getElementContext } from "react-grab/primitives";

type HostMessage = { dorks?: unknown; type?: unknown; on?: unknown };

const w = window as typeof window & { __dorksOverlay?: boolean };
if (w.parent !== w && !w.__dorksOverlay) {
  w.__dorksOverlay = true;
  const post = (m: Record<string, unknown>) => w.parent.postMessage({ dorks: "overlay", v: 1, ...m }, "*");
  let picking = false;
  let cursor = "";
  let frame = 0;
  let last: { x: number; y: number } | null = null;

  const hover = () => {
    frame = 0;
    if (!picking || !last) return;
    const el = getElementAtPoint(last.x, last.y);
    if (!el) return post({ type: "hover", box: null });
    const b = getElementBounds(el);
    post({ type: "hover", box: { x: b.x, y: b.y, width: b.width, height: b.height, radius: b.borderRadius, label: el.tagName.toLowerCase() } });
  };
  const onMove = (e: MouseEvent) => {
    last = { x: e.clientX, y: e.clientY };
    frame ||= requestAnimationFrame(hover);
  };
  const block = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e: MouseEvent) => {
    block(e);
    const el = getElementAtPoint(e.clientX, e.clientY);
    if (!el) return;
    stop();
    post({ type: "picking", on: false });
    getElementContext(el).then(
      (ctx) => post({ type: "grab", snippet: ctx.snippet }),
      () => post({ type: "grab", snippet: el.outerHTML.slice(0, 2000) }),
    );
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    stop();
    post({ type: "picking", on: false });
  };
  const clear = () => post({ type: "hover", box: null });
  const blocked = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"] as const;

  const start = () => {
    if (picking) return;
    picking = true;
    cursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    w.addEventListener("mousemove", onMove, true);
    w.addEventListener("click", onClick, true);
    for (const t of blocked) w.addEventListener(t, block, true);
    w.addEventListener("keydown", onKey, true);
    w.addEventListener("scroll", clear, true);
    document.documentElement.addEventListener("mouseleave", clear);
  };
  const stop = () => {
    if (!picking) return;
    picking = false;
    last = null;
    document.documentElement.style.cursor = cursor;
    w.removeEventListener("mousemove", onMove, true);
    w.removeEventListener("click", onClick, true);
    for (const t of blocked) w.removeEventListener(t, block, true);
    w.removeEventListener("keydown", onKey, true);
    w.removeEventListener("scroll", clear, true);
    document.documentElement.removeEventListener("mouseleave", clear);
    clear();
  };

  w.addEventListener("message", (e: MessageEvent<HostMessage>) => {
    if (e.source !== w.parent || !e.data || e.data.dorks !== "host") return;
    if (e.data.type === "hello") post({ type: "ready" });
    else if (e.data.type === "pick") (e.data.on === true ? start : stop)();
  });
  post({ type: "ready" });
}
