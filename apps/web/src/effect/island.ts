import type { View } from '@effect/ui'
import { Html } from '@effect/ui/html'
import { Schema } from 'effect'

/**
 * An island: an Effect UI root that React mounts into a DOM node it owns (EffectIsland.tsx), so the web app moves to Effect UI one
 * leaf at a time (docs/effect-ui-migration.md).
 *
 * A mounted root's props are fixed, and a parent can only talk to a child through props, so the island is a thin root between React
 * and the ported component: it holds the props React last gave it in its Model, renders the component with them, and re-emits the
 * component's events as its own, which the mount hands back to React. React sends it `ReceivedProps` through `Root.send` when its props
 * change. The ported component knows nothing of React: once its React parent is ported too, that parent renders it directly and the
 * island goes away.
 */

export interface Island<P, E> {
  readonly component: ReturnType<typeof islandDef<P, unknown, E, unknown>>['component']
  /** The message EffectIsland sends the root when React's props change. */
  readonly receivedProps: (props: P) => IslandMessage<P, E>
}

export type IslandMessage<P, E> = { readonly _tag: 'ReceivedProps'; readonly props: P } | { readonly _tag: 'EmittedEvent'; readonly event: E }

const islandDef = <P, PI, E, EI>(options: {
  readonly name: string
  readonly props: Schema.Codec<P, PI>
  readonly events: Schema.Codec<E, EI>
  readonly view: (h: Html.H<IslandMessage<P, E>>, props: P, emit: (event: E) => IslandMessage<P, E>) => View.Content<IslandMessage<P, E>>
}) => {
  const ReceivedProps = Schema.TaggedStruct('ReceivedProps', { props: options.props })
  const EmittedEvent = Schema.TaggedStruct('EmittedEvent', { event: options.events })
  const message = Schema.Union([ReceivedProps, EmittedEvent])
  const emit = (event: E): IslandMessage<P, E> => ({ _tag: 'EmittedEvent', event })
  const component = Html.component({
    name: options.name,
    props: options.props,
    model: Schema.Struct({ props: options.props }),
    message,
    events: options.events,
    restore: false,
  }).make({
    init: ($) => ({ props: $.props }),
    update: ($, msg) => (msg._tag === 'ReceivedProps' ? { props: msg.props } : $.emit(msg.event)),
    view: (h, model) => options.view(h, model.props, emit),
  })
  return { component }
}

/** Makes the island for one ported component. `view` renders it with React's props and maps its events through `emit`. */
export const makeIsland = <P, PI, E, EI>(options: Parameters<typeof islandDef<P, PI, E, EI>>[0]): Island<P, E> => ({
  component: islandDef(options).component as Island<P, E>['component'],
  receivedProps: (props) => ({ _tag: 'ReceivedProps', props }),
})
