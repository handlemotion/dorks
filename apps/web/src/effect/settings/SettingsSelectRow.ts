import { UiSchema } from '@effect/ui'
import { Select, SelectItem } from '@effect/ui-kit'
import { Html } from '@effect/ui/html'
import { cn } from 'cn'
import { Schema } from 'effect'
import { CheckIcon, ChevronDownIcon } from '../icons.ts'
import { SettingsRow } from './kit.ts'

/**
 * One choice from a short list (SettingsSelectRow in components/settings/kit.tsx): the row's label on the left, a select as wide as its
 * choice on the right. The select is @effect/ui-kit's headless Select drawn with the classes of @dorks/ui's shadcn select (Base UI), so
 * it looks the same. The value is the caller's: the row only holds whether its popup is open, and emits what was picked.
 */

// packages/ui/src/components/ui/select.tsx: SelectTrigger, SelectContent and SelectItem, verbatim except for what the UI rules forbid
// outside the published shadcn files: the popup's elevation class (a no-op, the theme resets those tokens) and the focus ring in the
// trigger's transition list (the ring now appears without a fade).
const TRIGGER =
  "flex w-fit items-center justify-between gap-1.5 rounded-3xl border border-transparent bg-input/50 px-3 py-2 text-sm whitespace-nowrap transition-[color,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
const POPUP =
  'isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-3xl text-popover-foreground ring-1 ring-foreground/5 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 animate-none! relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150 **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[variant=destructive]:focus:bg-foreground/10! **:data-[variant=destructive]:text-accent-foreground! **:data-[variant=destructive]:**:text-accent-foreground!'
const ITEM =
  "relative flex w-full cursor-default items-center gap-2.5 rounded-2xl py-2 pr-8 pl-3 text-sm font-medium outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2"
// The positioner is a manual popover in the top layer: reset the browser's popover box (border, padding, background, overflow) and keep
// Base UI's 10px gap to the viewport's top and bottom (Tailwind's preflight zeroes every margin).
const POSITIONER = 'isolate z-50 my-2.5 overflow-visible border-0 bg-transparent p-0 text-inherit outline-none'

export const SettingsSelectRowProps = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
  value: Schema.String,
  options: Schema.Array(SelectItem),
})
export type SettingsSelectRowProps = typeof SettingsSelectRowProps.Type

export const SettingsSelectRowEvents = UiSchema.TaggedEnum({ Picked: { value: Schema.String } })
export type SettingsSelectRowEvents = typeof SettingsSelectRowEvents.Type

const SettingsSelectRowMessage = UiSchema.TaggedEnum({
  RequestedOpenSelect: {},
  RequestedCloseSelect: {},
  PickedSelectChoice: { value: Schema.String },
})

export const SettingsSelectRow = Html.component({
  name: 'SettingsSelectRow',
  props: SettingsSelectRowProps,
  model: Schema.Struct({ open: Schema.Boolean }),
  message: SettingsSelectRowMessage,
  events: SettingsSelectRowEvents,
  restore: false,
}).make({
  init: () => ({ open: false }),
  update: {
    RequestedOpenSelect: ($) => $.evolve({ open: true }),
    RequestedCloseSelect: ($) => $.evolve({ open: false }),
    PickedSelectChoice: ($, { value }) => $.evolve({ open: false }).emit(SettingsSelectRowEvents.Picked({ value })),
  },
  view: (h, model) =>
    SettingsRow(h, {
      label: h.props.label,
      ...(h.props.description === undefined ? {} : { description: h.props.description }),
      control: [
        Select(h, {
          props: { open: model.open, value: h.props.value, items: h.props.options, align: 'end' },
          onEmit: {
            RequestedOpen: () => SettingsSelectRowMessage.RequestedOpenSelect(),
            RequestedClose: () => SettingsSelectRowMessage.RequestedCloseSelect(),
            Picked: ({ value }) => (typeof value === 'string' ? SettingsSelectRowMessage.PickedSelectChoice({ value }) : undefined),
            Settled: () => undefined,
          },
          // The trigger and its popup, in one box that does not lay out (the popup sits in the top layer).
          view: (select) =>
            h.div
              .class('contents')
              .children(
                select
                  .trigger(h.button.attrs({ 'data-slot': 'select-trigger', 'data-size': 'sm', 'aria-label': h.props.label }).class(cn(TRIGGER, 'w-auto max-w-56 min-w-28')))
                  .children(
                    select.value(h.span.attr('data-slot', 'select-value').class('flex flex-1 text-left')),
                    select.icon(h.span.class('flex')).children(ChevronDownIcon(h).class('pointer-events-none size-4 text-muted-foreground')),
                  ),
                select
                  .positioner(h.div.class(POSITIONER))
                  .children(
                    select
                      .popup(h.div.attrs({ 'data-slot': 'select-content', 'data-align-trigger': 'true' }).class(POPUP))
                      .children(
                        h.props.options.map((option) =>
                          select
                            .item({ element: h.div.attr('data-slot', 'select-item').class(ITEM), value: option.value })
                            .children(
                              select.itemText(h.div.class('flex flex-1 shrink-0 gap-2 whitespace-nowrap')).children(option.label),
                              select
                                .itemIndicator({ element: h.span.class('pointer-events-none absolute right-2 flex size-4 items-center justify-center'), value: option.value })
                                ?.children(CheckIcon(h).class('pointer-events-none')),
                            ),
                        ),
                      ),
                  ),
              ),
        }),
      ],
    }),
})
