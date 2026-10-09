import { layoutNextLine, measureNaturalWidth, prepareWithSegments, type PrepareOptions } from '@chenglou/pretext'
import { useEffect, useRef, useState } from 'react'

const ELLIPSIS = '…'
const NBSP = ' '

/** One ResizeObserver for every instance: a sidebar has a row per chat, and one observer is cheaper than one per row. */
const onWidth = new WeakMap<Element, (width: number) => void>()
let observer: ResizeObserver | undefined
function observeWidth(el: Element, callback: (contentWidth: number) => void) {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) onWidth.get(entry.target)?.(entry.contentRect.width)
  })
  onWidth.set(el, callback)
  observer.observe(el)
  return () => {
    onWidth.delete(el)
    observer?.unobserve(el)
  }
}

const ellipsisWidths = new Map<string, number>()
function ellipsisWidth(font: string, options: PrepareOptions) {
  const key = `${font}|${options.letterSpacing}`
  let width = ellipsisWidths.get(key)
  if (width === undefined) {
    width = measureNaturalWidth(prepareWithSegments(ELLIPSIS, font, options))
    ellipsisWidths.set(key, width)
  }
  return width
}

/** Returns, for a content width, the text cut to fit it with an ellipsis (or the text itself when it fits). */
function fitter(el: Element, text: string) {
  const cs = getComputedStyle(el)
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const options = { letterSpacing: parseFloat(cs.letterSpacing) || 0 }
  // CSS collapses and trims whitespace. Non-breaking spaces then make the title one unbreakable run, so Pretext breaks it at
  // the grapheme where it overflows instead of moving whole words to a second line.
  const prepared = prepareWithSegments(text.trim().replace(/\s+/g, NBSP), font, options)
  const natural = measureNaturalWidth(prepared)
  const ellipsis = ellipsisWidth(font, options)
  return (width: number) => {
    if (natural <= width) return text
    const line = layoutNextLine(prepared, { segmentIndex: 0, graphemeIndex: 0 }, Math.max(0, width - ellipsis))
    return (line ? line.text.replaceAll(NBSP, ' ').trimEnd() : '') + ELLIPSIS
  }
}

/**
 * One line of text that is cut with an ellipsis exactly where it stops fitting.
 *
 * The cut point is computed with Pretext (canvas measurement, no DOM reads during layout) and recomputed on every width
 * change, so it stays correct live; only the cheap layout step reruns, the text is prepared once. It breaks on graphemes,
 * not words, and handles emoji and RTL. CSS `text-overflow: ellipsis` (the `truncate` utility on the same element) is the
 * fallback until the first measure, and if measuring fails. While the text is cut, the full text is the `title` and is
 * what assistive tech reads.
 *
 * Font and letter spacing are read from the element's computed style, so they always match the CSS.
 */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  // Tagged with the text it was computed for, so a new text renders in full (not a stale cut) until it is measured.
  const [cut, setCut] = useState<{ text: string; shown: string } | null>(null)
  const shown = cut?.text === text ? cut.shown : text

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let stop: (() => void) | undefined
    let alive = true
    const start = () => {
      if (!alive) return
      try {
        const fit = fitter(el, text)
        stop = observeWidth(el, (width) => {
          const next = fit(width)
          setCut((prev) => (prev?.text === text && prev.shown === next ? prev : { text, shown: next }))
        })
      } catch {
        // fall back to CSS truncation
      }
    }
    // Measure with the real font: before it loads, canvas would use a fallback and the cut would be wrong. Passing the text
    // loads the subsets (unicode-range) it needs, not just Latin.
    const cs = getComputedStyle(el)
    document.fonts.load(`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, text).then(start, start)
    return () => {
      alive = false
      stop?.()
    }
  }, [text])

  const isCut = shown !== text
  return (
    <span ref={ref} className={className} title={isCut ? text : undefined}>
      {isCut ? (
        <>
          <span aria-hidden>{shown}</span>
          <span className="sr-only">{text}</span>
        </>
      ) : (
        text
      )}
    </span>
  )
}
