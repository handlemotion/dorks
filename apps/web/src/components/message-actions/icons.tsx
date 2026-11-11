import type { ReactNode } from 'react'

/**
 * The Lucide stroke set aicss's Message Actions ships with, drawn at 1.125 non-scaling strokes. A glyph that animates its own parts
 * (the reply arrow) plays when its svg carries `ma-play`.
 */
const cn = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

export type GlyphProps = { className?: string; size?: number }

function Glyph({ className, size = 12, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      className={cn('group/ma [vector-effect:non-scaling-stroke] [&_*]:[vector-effect:non-scaling-stroke]', className)}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.125}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const GoodIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    <path d="M7 10v12" />
  </Glyph>
)

export const BadIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
    <path d="M17 14V2" />
  </Glyph>
)

export const CopyIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Glyph>
)

/** The check draws itself (stroke-dashoffset 28 → 0) while its row says Copied. */
export const CopiedIcon = (p: GlyphProps & { drawing: boolean }) => (
  <Glyph className={p.className} size={p.size}>
    <path d="M4 12 9 17 20 6" className={cn('[stroke-dasharray:28] [stroke-dashoffset:0]', p.drawing && 'motion-safe:animate-ma-draw-check')} />
  </Glyph>
)

export const ReplyIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M20 18v-2a4 4 0 0 0-4-4" />
    <line className="origin-[66.667%_50%] [transform-box:view-box] motion-safe:group-[.ma-play]/ma:animate-ma-reply-grow" x1="16" y1="12" x2="4" y2="12" />
    <path className="[transform-box:view-box] motion-safe:group-[.ma-play]/ma:animate-ma-reply-head" d="m9 17-5-5 5-5" />
  </Glyph>
)
