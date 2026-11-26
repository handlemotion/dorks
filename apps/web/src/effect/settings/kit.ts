import type { View } from '@effect/ui'
import type { Html } from '@effect/ui/html'
import { cn } from 'cn'

/**
 * The settings kit (components/settings/kit.tsx) as Effect UI view functions, with the same classes. Only the pieces a ported page uses
 * are here; port the rest of kit.tsx as pages move over, and delete kit.tsx once no React page uses it.
 */

/** The page's stack of sections, 32px apart. */
export const SettingsSections = <M>(h: Html.H<M>) => h.div.class('flex flex-col gap-8')

/** A titled set of groups. The title is a muted label, inset to the rows' text, with an optional one-line description. */
export const SettingsSection = <M, C extends View.Children<M>>(h: Html.H<M>, options: { readonly title: string; readonly description?: string; readonly children: C }) =>
  h.section
    .attr('aria-label', options.title)
    .class(cn('flex min-w-0 flex-col', options.description ? 'gap-3' : 'gap-2'))
    .children(
      h.div
        .class('flex min-h-7 items-center justify-between gap-3 px-4')
        .children(
          h.div
            .class('min-w-0')
            .children(
              h.h2.class('text-sm text-muted-foreground').children(options.title),
              options.description && h.p.class('mt-0.5 text-xs text-pretty text-muted-foreground').children(options.description),
            ),
        ),
      h.div.class('flex min-w-0 flex-col gap-2.5').children(options.children),
    )

/** A raised column of rows. */
export const SettingsGroup = <M>(h: Html.H<M>) =>
  h.div.class('@container flex min-w-0 flex-col divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-surface dark:border-transparent')

// Narrower than 448px (a phone), the control drops under the text and takes the row's width.
const ROW = 'flex min-h-13 w-full min-w-0 flex-col items-stretch gap-3 py-2.5 ps-4 pe-3 text-start @md:flex-row @md:items-center @md:gap-4'

/** The generic row: text on the left, any control on the right. */
export const SettingsRow = <M, C extends View.Children<M>>(h: Html.H<M>, options: { readonly label: string; readonly description?: string; readonly control: C }) =>
  h.div
    .attr('data-slot', 'settings-row')
    .class(ROW)
    .children(
      h.div
        .class('flex min-w-0 flex-1 items-center gap-3')
        .children(
          h.div
            .class('flex min-w-0 flex-1 flex-col gap-1')
            .children(
              h.span.class('block min-w-0 truncate text-sm leading-4 text-foreground').children(options.label),
              options.description && h.div.class('text-xs leading-4 text-pretty text-muted-foreground').children(options.description),
            ),
        ),
      h.div.class('flex min-w-0 shrink-0 items-center gap-2 @md:justify-end').children(options.control),
    )
