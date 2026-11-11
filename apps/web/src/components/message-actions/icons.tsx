import type { ReactNode } from 'react'

/**
 * The Lucide stroke set aicss's Message Actions ships with, drawn at 1.125 non-scaling strokes. A glyph that animates its own parts
 * (the smile's wink, the reply arrow) plays when its svg carries `ma-play`.
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

export const SmileIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="10" />
    <path className="group-[.ma-play]/ma:opacity-0" d="M8 14s1.5 2 4 2 4-2 4-2" />
    <path className="opacity-0 group-[.ma-play]/ma:opacity-100" d="M8 13.5c.9 1.7 2.3 2.5 4 2.5s3.1-.8 4-2.5" />
    <line x1="9" x2="9.01" y1="9" y2="9" />
    <line className="motion-safe:group-[.ma-play]/ma:animate-ma-wink-shut" x1="15" x2="15.01" y1="9" y2="9" />
    <line className="opacity-0 motion-safe:group-[.ma-play]/ma:animate-ma-wink-line" x1="13.8" x2="16.2" y1="9.15" y2="9.15" />
  </Glyph>
)

export const ReplyIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M20 18v-2a4 4 0 0 0-4-4" />
    <line className="origin-[66.667%_50%] [transform-box:view-box] motion-safe:group-[.ma-play]/ma:animate-ma-reply-grow" x1="16" y1="12" x2="4" y2="12" />
    <path className="[transform-box:view-box] motion-safe:group-[.ma-play]/ma:animate-ma-reply-head" d="m9 17-5-5 5-5" />
  </Glyph>
)

export const MoreIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Glyph>
)

export const AloudIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
    <path d="M16 9a5 5 0 0 1 0 6" />
    <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
  </Glyph>
)

export const ForkIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </Glyph>
)

export const ReportIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
  </Glyph>
)

export const SearchIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.34-4.34" />
  </Glyph>
)

export const AddEmojiIcon = (p: GlyphProps) => (
  <Glyph {...p}>
    <path d="M22 11v1a10 10 0 1 1-9-10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" x2="9.01" y1="9" y2="9" />
    <line x1="15" x2="15.01" y1="9" y2="9" />
    <path d="M16 5h6" />
    <path d="M19 2v6" />
  </Glyph>
)
