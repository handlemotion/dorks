import { createElement, type ComponentType } from 'react'
import { CirclePlay, GitPullRequest, GitPullRequestDraft, Plus, SlidersHorizontal, type LucideIcon } from 'lucide-react'

// The only file that names the icon set; swap it here.
export type Glyph = ComponentType<{ className?: string; ariaHidden?: boolean }>

const glyph =
  (Icon: LucideIcon): Glyph =>
  ({ className, ariaHidden }) =>
    createElement(Icon, { className, 'aria-hidden': ariaHidden })

export const IconPlusMedium = glyph(Plus)
export const IconPlayCircle = glyph(CirclePlay)
export const IconPlayground = glyph(SlidersHorizontal)
export const IconPullRequest = glyph(GitPullRequest)
export const IconPullRequestClosedSimple = glyph(GitPullRequestDraft)
