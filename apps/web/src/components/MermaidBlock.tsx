import { useEffect, useId, useState } from 'react'
import { useTheme } from 'next-themes'
import { CodeBlockCopyButton } from '@dorks/ui/code-block'

// Mermaid is large and only draws diagrams: it loads on the first mermaid fence, not with the app. One render at a time, since
// mermaid's initialize is global and the theme is set on it before each render.
let queue: Promise<unknown> = Promise.resolve()
const load = () => import('mermaid').then((m) => m.default)

function renderDiagram(id: string, code: string, dark: boolean) {
  const run = queue.then(async () => {
    const mermaid = await load()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'neutral',
      fontFamily: 'var(--font-sans)',
      themeVariables: { fontSize: '14px' },
    })
    return fitted((await mermaid.render(id, code)).svg)
  })
  queue = run.catch(() => {})
  return run
}

// Mermaid draws at width="100%" capped by its own width, so a wide diagram shrinks to fit the message and its text gets tiny. It still
// fits the message, but shrinks to no less than MIN_SCALE of its size; past that the island scrolls sideways.
const MIN_SCALE = 0.7
function fitted(svg: string) {
  const width = Number(/max-width:\s*([\d.]+)px/.exec(svg)?.[1])
  if (!width) return svg
  return svg.replace(/ style="max-width:[^"]*"/, '').replace(/^<svg([^>]*?) width="100%"/, `<svg$1 width="${width}" style="max-width: 100%; min-width: ${Math.round(width * MIN_SCALE)}px;"`)
}

/**
 * A `mermaid` fence drawn as its diagram: the code block's white island (same radius and border) without the header row, copy on
 * hover. While the fence streams in, or when the diagram does not parse, it falls back to the ordinary code block.
 */
export function MermaidBlock({ code, incomplete, fallback }: { code: string; incomplete: boolean; fallback: React.ReactNode }) {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const id = 'mermaid-' + useId().replace(/[^a-zA-Z0-9-]/g, '')
  const [state, setState] = useState<{ svg: string; key: string } | { error: true; key: string } | null>(null)
  const key = `${dark}:${code}`

  useEffect(() => {
    if (incomplete) return
    let live = true
    renderDiagram(id, code, dark).then(
      (svg) => live && setState({ svg, key }),
      () => {
        // Mermaid leaves its error drawing in the body when a render fails.
        document.getElementById('d' + id)?.remove()
        if (live) setState({ error: true, key })
      },
    )
    return () => {
      live = false
    }
  }, [id, code, dark, incomplete, key])

  if (incomplete || !state || 'error' in state) {
    // Keep the last diagram while a theme change redraws it; otherwise the code until the diagram is ready.
    if (state && 'svg' in state && !incomplete) return <Island svg={state.svg} code={code} />
    return fallback
  }
  return <Island svg={state.svg} code={code} />
}

function Island({ svg, code }: { svg: string; code: string }) {
  return (
    <div className="group/mermaid relative my-4 overflow-hidden rounded-[10px] border border-border bg-surface dark:bg-background">
      <div
        role="img"
        aria-label="Diagram"
        className="scrollbar-thin flex overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:shrink-0"
        // Mermaid's output with securityLevel strict (its labels are sanitized by DOMPurify).
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within/mermaid:opacity-100 group-hover/mermaid:opacity-100 pointer-coarse:opacity-100">
        <CodeBlockCopyButton value={code} className="size-6 rounded-[6px] bg-surface text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground dark:bg-background" />
      </div>
    </div>
  )
}
