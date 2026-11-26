import { UiSchema } from '@effect/ui'
import { Html } from '@effect/ui/html'
import { Schema } from 'effect'
import { SettingsGroup, SettingsSection, SettingsSections } from './kit.ts'
import { SettingsSelectRow } from './SettingsSelectRow.ts'

/**
 * Settings > Appearance, the first page on Effect UI (docs/effect-ui-migration.md). The theme is the caller's (next-themes, through the
 * React island in components/settings/PersonalPages.tsx): the page shows it and emits the one the user picks.
 */

export const Theme = Schema.Literals(['system', 'light', 'dark'])
export type Theme = typeof Theme.Type

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const

const isTheme = Schema.is(Theme)

export const AppearancePageProps = Schema.Struct({ theme: Theme })
export type AppearancePageProps = typeof AppearancePageProps.Type

export const AppearancePageEvents = UiSchema.TaggedEnum({ PickedTheme: { theme: Theme } })
export type AppearancePageEvents = typeof AppearancePageEvents.Type

const AppearancePageMessage = UiSchema.TaggedEnum({ PickedAppearance: { value: Schema.String } })

export const AppearancePage = Html.component({
  name: 'AppearancePage',
  props: AppearancePageProps,
  model: Schema.Null,
  message: AppearancePageMessage,
  events: AppearancePageEvents,
}).make({
  init: () => null,
  update: {
    PickedAppearance: ($, { value }) => (isTheme(value) ? $.emit(AppearancePageEvents.PickedTheme({ theme: value })) : $.model),
  },
  view: (h) =>
    SettingsSections(h).children(
      SettingsSection(h, {
        title: 'Theme',
        children: [
          SettingsGroup(h).children(
            SettingsSelectRow(h, {
              props: { label: 'Appearance', value: h.props.theme, options: THEMES },
              onEmit: { Picked: ({ value }) => AppearancePageMessage.PickedAppearance({ value }) },
            }),
          ),
        ],
      }),
    ),
})
