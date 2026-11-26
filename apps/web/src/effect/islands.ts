import { AppearancePage, AppearancePageEvents, AppearancePageProps } from './settings/AppearancePage.ts'
import { makeIsland } from './island.ts'

/** Every Effect UI component that React renders, as an island (island.ts). One per ported leaf, until its React parent is ported too. */

export const AppearancePageIsland = makeIsland({
  name: 'AppearancePageIsland',
  props: AppearancePageProps,
  events: AppearancePageEvents,
  view: (h, props, emit) => AppearancePage(h, { props, onEmit: emit }),
})
