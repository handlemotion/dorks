import type { Html } from '@effect/ui/html'

/**
 * Lucide icons drawn with Effect UI's SVG builders, with lucide-react's attributes and class names so they render the same pixels. Add an
 * icon here, with its lucide name, when a ported view needs it.
 */
const Lucide = <M>(h: Html.H<M>, name: string) =>
  h.svg.class('lucide', `lucide-${name}`).attrs({
    xmlns: 'http://www.w3.org/2000/svg',
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })

export const ChevronDownIcon = <M>(h: Html.H<M>) => Lucide(h, 'chevron-down').children(h.path.attr('d', 'm6 9 6 6 6-6'))

export const CheckIcon = <M>(h: Html.H<M>) => Lucide(h, 'check').children(h.path.attr('d', 'M20 6 9 17l-5-5'))
