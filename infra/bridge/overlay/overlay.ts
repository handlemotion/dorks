// The preview overlay: the script the preview proxy (src/preview-proxy.ts) adds to every page of a previewed dev server. The owner's
// app shows the page in a frame on another origin, so it cannot reach into it; this script does the work that needs the page's own
// DOM (picking elements and text, finding comment anchors again, capturing an area as an image) and talks to the app over
// postMessage. It does nothing unless the page is framed, and listens only to its parent window. It draws nothing on the page:
// the app draws every highlight, bubble and box over the frame from the positions posted here.
//
// Protocol (every message carries `dorks`: "overlay" from here, "host" from the app):
//   overlay → host  {type: "ready", path, bg}             on load, and in answer to "hello" (bg: the page's fill, a CSS color)
//                   {type: "location", path}              the page's path changed (pushState, popstate, hashchange)
//                   {type: "hover", box | null}           the element or text under the pointer while picking, in the frame's viewport
//                   {type: "grab", snippet, anchor, box}  a picked element: React Grab's snippet (markup, component, source) and its anchor
//                   {type: "selection", anchor, box}      text picked in "text" mode
//                   {type: "picking", on: false}          picking ended here (a pick, or Escape)
//                   {type: "marks", marks: [{id, rects}]} where the comment anchors are now (rects: null when not on this page)
//                   {type: "captured", id, data | error}  an area as a PNG data URL
//                   {type: "pointer", x, y, box, label}   while tracking (the rulers): where the pointer is, and the element under it
//   host → overlay  {type: "hello"} | {type: "pick", on, mode?: "element" | "text"} | {type: "marks", marks: MarkInput[]}
//                   {type: "capture", id, rect} | {type: "reveal", id} | {type: "track", on}
// Replies go to the parent with targetOrigin "*": they hold the page's own markup and text, which anyone with the (public) URL can
// read anyway.
import { domToPng } from "modern-screenshot";
import { getElementAtPoint, getElementBounds, getElementContext, getElementSelector } from "react-grab/primitives";

type Rect = { x: number; y: number; width: number; height: number };
type MarkInput = { id: string; kind: "element" | "text" | "area"; path: string; selector: string; quote?: string; prefix?: string; suffix?: string; rect?: Rect };
type HostMessage = { dorks?: unknown; type?: unknown; on?: unknown; mode?: unknown; marks?: unknown; id?: unknown; rect?: unknown };

const CONTEXT = 32;
const w = window as typeof window & { __dorksOverlay?: boolean };

const path = () => location.pathname + location.search + location.hash;
const rectOf = (r: DOMRect | Rect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const union = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};

/** The text nodes under `root` with their offsets in its text, for mapping a quote back to a Range. */
function textIndex(root: Node) {
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  return { nodes, text };
}

function rangeAt(index: ReturnType<typeof textIndex>, from: number, to: number): Range | null {
  const at = (offset: number) => {
    for (let i = index.nodes.length - 1; i >= 0; i--) {
      const n = index.nodes[i]!;
      if (n.start <= offset) return { node: n.node, offset: Math.min(offset - n.start, n.node.data.length) };
    }
    return null;
  };
  const a = at(from);
  const b = at(to);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

/** Finds a quoted passage again: every occurrence inside the anchor's element, the one whose surroundings match best. */
function findText(m: MarkInput): Range | null {
  if (!m.quote) return null;
  const root = (m.selector && safeQuery(m.selector)) || document.body;
  const index = textIndex(root);
  let best: { at: number; score: number } | null = null;
  for (let at = index.text.indexOf(m.quote); at >= 0; at = index.text.indexOf(m.quote, at + 1)) {
    const before = index.text.slice(Math.max(0, at - CONTEXT), at);
    const after = index.text.slice(at + m.quote.length, at + m.quote.length + CONTEXT);
    const score = (m.prefix && before.endsWith(m.prefix) ? 2 : 0) + (m.suffix && after.startsWith(m.suffix) ? 2 : 0);
    if (!best || score > best.score) best = { at, score };
  }
  return best ? rangeAt(index, best.at, best.at + m.quote.length) : null;
}

function safeQuery(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/** Where the comment's anchor is in the viewport now. */
function locate(m: MarkInput): Rect[] | null {
  if (m.path !== path()) return null;
  if (m.kind === "area") return m.rect ? [{ ...m.rect, x: m.rect.x - window.scrollX, y: m.rect.y - window.scrollY }] : null;
  if (m.kind === "text") {
    const r = findText(m);
    if (!r) return null;
    const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0).map(rectOf);
    return rects.length ? rects : null;
  }
  const el = safeQuery(m.selector);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return b.width || b.height ? [rectOf(b)] : null;
}

async function anchorFor(el: Element) {
  const ctx = await getElementContext(el).catch(() => null);
  const where = {
    path: path(),
    selector: ctx?.selector ?? getElementSelector(el),
    label: el.tagName.toLowerCase(),
    ...(ctx?.componentName ? { component: ctx.componentName } : {}),
    ...(ctx?.filePath ? { file: ctx.filePath } : {}),
    ...(ctx?.lineNumber ? { line: ctx.lineNumber } : {}),
  };
  return { ctx, where };
}

/** The page's fill: the body's background, else the root's, else white (a transparent page shows the browser's white). */
function fill() {
  const doc = w.document;
  for (const el of [doc.body, doc.documentElement]) {
    const bg = el ? getComputedStyle(el).backgroundColor : "";
    if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return "rgb(255, 255, 255)";
}

if (w.parent !== w && !w.__dorksOverlay) {
  w.__dorksOverlay = true;
  const post = (m: Record<string, unknown>) => w.parent.postMessage({ dorks: "overlay", v: 1, ...m }, "*");
  let mode: "element" | "text" | null = null;
  let cursor = "";
  let frame = 0;
  let last: { x: number; y: number } | null = null;
  let marks: MarkInput[] = [];
  let markFrame = 0;
  let lastPath = path();

  // ---- comment marks: positions follow scrolling, resizing, re-renders and navigation
  const sendMarks = () => {
    markFrame = 0;
    post({ type: "marks", marks: marks.map((m) => ({ id: m.id, rects: locate(m) })) });
  };
  const remeasure = () => {
    if (marks.length) markFrame ||= requestAnimationFrame(sendMarks);
  };
  const changed = () => {
    if (path() === lastPath) return;
    lastPath = path();
    post({ type: "location", path: lastPath });
    remeasure();
  };
  for (const k of ["pushState", "replaceState"] as const) {
    const orig = history[k].bind(history);
    history[k] = (...args: Parameters<History["pushState"]>) => {
      orig(...args);
      changed();
    };
  }
  w.addEventListener("popstate", changed);
  w.addEventListener("hashchange", changed);
  w.addEventListener("scroll", remeasure, true);
  w.addEventListener("resize", remeasure);
  new MutationObserver(remeasure).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });

  // ---- picking
  const hover = () => {
    frame = 0;
    if (mode !== "element" || !last) return;
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
    const box = rectOf(el.getBoundingClientRect());
    stop();
    post({ type: "picking", on: false });
    void anchorFor(el).then(({ ctx, where }) =>
      post({ type: "grab", snippet: ctx?.snippet ?? el.outerHTML.slice(0, 2000), anchor: { kind: "element", ...where, html: (ctx?.htmlPreview ?? el.outerHTML).slice(0, 4000) }, box }),
    );
  };
  // Text mode: the page's own selection, taken when the mouse comes up with something selected.
  const onMouseUp = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const quote = range.toString().trim();
    if (!quote) return;
    const common = range.commonAncestorContainer;
    const el = common instanceof Element ? common : common.parentElement;
    if (!el) return;
    const index = textIndex(el);
    const before = document.createRange();
    before.setStart(el, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length + (range.toString().length - range.toString().trimStart().length);
    const prefix = index.text.slice(Math.max(0, start - CONTEXT), start);
    const suffix = index.text.slice(start + quote.length, start + quote.length + CONTEXT);
    const box = union([...range.getClientRects()].map(rectOf));
    stop();
    post({ type: "picking", on: false });
    void anchorFor(el).then(({ where }) => post({ type: "selection", anchor: { kind: "text", ...where, label: el.tagName.toLowerCase(), quote: quote.slice(0, 2000), prefix, suffix }, box }));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !mode) return;
    stop();
    post({ type: "picking", on: false });
  };
  const clear = () => post({ type: "hover", box: null });
  const blocked = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"] as const;

  const start = (next: "element" | "text") => {
    stop();
    mode = next;
    cursor = document.documentElement.style.cursor;
    w.addEventListener("keydown", onKey, true);
    if (next === "text") {
      document.documentElement.style.cursor = "text";
      w.addEventListener("mouseup", onMouseUp, true);
      return;
    }
    document.documentElement.style.cursor = "crosshair";
    w.addEventListener("mousemove", onMove, true);
    w.addEventListener("click", onClick, true);
    for (const t of blocked) w.addEventListener(t, block, true);
    w.addEventListener("scroll", clear, true);
    document.documentElement.addEventListener("mouseleave", clear);
  };
  function stop() {
    if (!mode) return;
    const was = mode;
    mode = null;
    last = null;
    document.documentElement.style.cursor = cursor;
    w.removeEventListener("keydown", onKey, true);
    if (was === "text") return void w.removeEventListener("mouseup", onMouseUp, true);
    w.removeEventListener("mousemove", onMove, true);
    w.removeEventListener("click", onClick, true);
    for (const t of blocked) w.removeEventListener(t, block, true);
    w.removeEventListener("scroll", clear, true);
    document.documentElement.removeEventListener("mouseleave", clear);
    clear();
  }

  // ---- the rulers: the pointer and the element under it, while the app asks; the page keeps every event
  let tracking = false;
  let trackFrame = 0;
  let at: { x: number; y: number } | null = null;
  const sendPointer = () => {
    trackFrame = 0;
    if (!at) return post({ type: "pointer", x: null });
    const el = document.elementFromPoint(at.x, at.y);
    const b = el && el !== document.documentElement && el !== document.body ? rectOf(el.getBoundingClientRect()) : null;
    post({ type: "pointer", x: at.x, y: at.y, box: b, label: el ? el.tagName.toLowerCase() : null });
  };
  const onTrackMove = (e: MouseEvent) => {
    at = { x: e.clientX, y: e.clientY };
    trackFrame ||= requestAnimationFrame(sendPointer);
  };
  const onTrackLeave = () => {
    at = null;
    trackFrame ||= requestAnimationFrame(sendPointer);
  };
  const track = (on: boolean) => {
    if (on === tracking) return;
    tracking = on;
    if (on) {
      w.addEventListener("mousemove", onTrackMove, true);
      w.addEventListener("scroll", onTrackLeave, true);
      document.documentElement.addEventListener("mouseleave", onTrackLeave);
    } else {
      w.removeEventListener("mousemove", onTrackMove, true);
      w.removeEventListener("scroll", onTrackLeave, true);
      document.documentElement.removeEventListener("mouseleave", onTrackLeave);
    }
  };

  // ---- an area as an image: the page rendered from its DOM, cut to the viewport rectangle the owner drew
  const capture = async (id: unknown, r: Rect) => {
    try {
      const scale = Math.min(2, w.devicePixelRatio || 1);
      const full = await domToPng(document.documentElement, {
        width: w.innerWidth,
        height: w.innerHeight,
        scale,
        style: { transform: `translate(${-w.scrollX}px, ${-w.scrollY}px)` },
      });
      const img = new Image();
      img.src = full;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(r.width * scale));
      canvas.height = Math.max(1, Math.round(r.height * scale));
      canvas.getContext("2d")!.drawImage(img, r.x * scale, r.y * scale, r.width * scale, r.height * scale, 0, 0, canvas.width, canvas.height);
      post({ type: "captured", id, data: canvas.toDataURL("image/png"), scroll: { x: w.scrollX, y: w.scrollY } });
    } catch (e) {
      post({ type: "captured", id, error: e instanceof Error ? e.message : "capture failed" });
    }
  };

  w.addEventListener("message", (e: MessageEvent<HostMessage>) => {
    const d = e.data;
    if (e.source !== w.parent || !d || d.dorks !== "host") return;
    if (d.type === "hello") post({ type: "ready", path: path(), bg: fill() });
    else if (d.type === "pick") {
      if (d.on === true) start(d.mode === "text" ? "text" : "element");
      else stop();
    } else if (d.type === "marks" && Array.isArray(d.marks)) {
      marks = d.marks as MarkInput[];
      sendMarks();
    } else if (d.type === "capture" && d.rect && typeof d.rect === "object") void capture(d.id, d.rect as Rect);
    else if (d.type === "track") track(d.on === true);
    else if (d.type === "reveal" && typeof d.id === "string") {
      const m = marks.find((x) => x.id === d.id);
      const target = m && (m.kind === "text" ? findText(m)?.startContainer.parentElement : safeQuery(m.selector));
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
  post({ type: "ready", path: path(), bg: fill() });
}
