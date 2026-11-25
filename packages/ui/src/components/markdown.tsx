"use client"

import * as React from "react"
import { cn } from "cn"
import { escapeHtml } from "@pierre/words/html"
import { defaultUrlTransform, Markdown as Words, type Components, type PluginConfig, type ReactiveIslands } from "@pierre/words/react"

import { useHighlightedCode } from "#hooks/use-highlighted-code"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "#ui/code-block"

/** A fenced code block: its code (no trailing newline), the fence's language (`""` when it has none), and whether the fence is still open. */
type MarkdownCodeBlockProps = { code: string; language: string; incomplete: boolean }
/** A markdown image, its source as written (not checked: the component decides what it can load). */
type MarkdownImageProps = { src: string; alt: string }

function MarkdownCodeBlock({ code, language, incomplete }: MarkdownCodeBlockProps) {
  const lines = useHighlightedCode(code, language)

  // The ring is inset: the markdown container clips overflow, which cut an outer ring to its top edge. No line numbers, as in the
  // published Markdown example, so the code starts on the title's edge. Its own 16px above and below: the container's space-y-4
  // only spaces top-level blocks, so a fence inside a list item sat flush against the text around it (the margins collapse with
  // space-y-4 at the top level, and the container's first/last-child rules still zero them at its edges).
  return (
    <CodeBlock className="my-4 bg-background ring-inset">
      <CodeBlockHeader>
        <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} disabled={incomplete} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function MarkdownImage({ src, alt }: MarkdownImageProps) {
  const safe = defaultUrlTransform(src)
  return safe ? <img src={safe} alt={alt} loading="lazy" className="max-w-full rounded-lg" /> : null
}

/*
 * Words (`@pierre/words`) parses and streams the markdown into the DOM itself; React only owns the container. Code blocks and images
 * are React components, so they render as Words "islands": each is a host element Words keeps across streamed updates (patching its
 * data in place), and React mounts the component into it with a portal. Every island of a kind shares the id `[name`, which Words
 * numbers by position, so a streaming fence keeps its component (and its state) from first line to closing fence.
 */
const CODE = "md-code"
const IMAGE = "md-image"

function island(tag: "div" | "span", name: string, data: Record<string, unknown>) {
  const id = `[${name}`
  const json = escapeHtml(JSON.stringify({ id, ...data }))
  return `<${tag} data-words-island="${name}" data-words-island-id="${id}" data-words-island-data="${json}"><${tag} data-words-island-content></${tag}><${tag} data-words-island-fallback></${tag}></${tag}>`
}

// Every fence, whatever its language (Words looks a renderer up with `language.includes(lang)`). Module-level: Words compares plugins
// by their render function, and a new one would reformat the whole message.
const ANY_LANGUAGE = { includes: () => true, toString: () => "*" } as unknown as string[]
const PLUGINS: PluginConfig = {
  renderers: [
    {
      language: ANY_LANGUAGE,
      render: ({ code, language, isIncomplete }) => island("div", CODE, { code: code.replace(/\n$/, ""), language: language === "text" ? "" : language, incomplete: isIncomplete }),
    },
  ],
}

// Words checks image sources against its own allow-list (http(s) and relative). Agents also paste `data:image/` screenshots and ids
// the app resolves, so every source is passed through as a fragment, which always passes, and the image component judges it.
const SRC_PREFIX = "#md-src:"
const urlTransform = (url: string, key: "href" | "src") => (key === "src" ? SRC_PREFIX + encodeURIComponent(url) : defaultUrlTransform(url))

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" }
const attr = (html: string, name: string) => {
  const raw = new RegExp(` ${name}="([^"]*)"`).exec(html)?.[1] ?? ""
  return raw.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ENTITIES[e])
}

/** Adds classes (and any other attributes) to the element's opening tag. Words writes no class of its own. */
const withAttrs = (attrs: string) => (html: string) => html.replace(/^<([a-z0-9]+)/, `<$1 ${attrs}`)
const withClass = (className: string) => withAttrs(`class="${className}"`)

// The look Streamdown gave each element, kept as it was. Hooks return HTML strings: Words renders no React elements of its own.
const COMPONENTS: Components = {
  h1: withClass("mt-6 mb-2 font-semibold text-3xl"),
  h2: withClass("mt-6 mb-2 font-semibold text-2xl"),
  h3: withClass("mt-6 mb-2 font-semibold text-xl"),
  h4: withClass("mt-6 mb-2 font-semibold text-lg"),
  h5: withClass("mt-6 mb-2 font-semibold text-base"),
  h6: withClass("mt-6 mb-2 font-semibold text-sm"),
  strong: withClass("font-semibold"),
  ul: withClass("list-inside list-disc whitespace-normal [li_&]:pl-6"),
  ol: withClass("list-inside list-decimal whitespace-normal [li_&]:pl-6"),
  li: withClass("py-1 [&>p]:inline"),
  blockquote: withClass("my-4 border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic"),
  hr: withClass("my-6 border-border"),
  inlineCode: withClass("rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]"),
  // Links are blue, always (so they stand out in a message), underlined on hover, and open in a new tab: in the desktop app the shell
  // hands them to the default browser (boot.rs, `on_new_window`).
  a: withAttrs('target="_blank" rel="noreferrer" class="wrap-anywhere font-medium text-link underline decoration-link/30 underline-offset-2 transition-colors hover:decoration-link"'),
  // Just the table in one 6px border: it scrolls sideways when wide, with a header fill and row rules.
  table: (html) => `<div class="my-4 overflow-x-auto rounded-md border border-border">${withClass("w-full divide-y divide-border")(html)}</div>`,
  thead: withClass("bg-muted/80"),
  tbody: withClass("divide-y divide-border"),
  tr: withClass("border-border"),
  th: withClass("whitespace-nowrap px-4 py-2 text-left font-semibold text-sm"),
  td: withClass("px-4 py-2 text-sm"),
  // A paragraph of nothing but images is a row of them, wrapping. Still a block, so it keeps the paragraph gap below as well as above.
  p: (html) => (html.replace(IMAGE_ISLANDS, "").replace(/^<p data-markdown="p">\s*<\/p>$/, "") === "" ? withClass("flex flex-wrap items-start gap-2")(html) : html),
  img: (html) => {
    const src = attr(html, "src")
    return island("span", IMAGE, { src: src.startsWith(SRC_PREFIX) ? decodeURIComponent(src.slice(SRC_PREFIX.length)) : src, alt: attr(html, "alt") })
  },
}

// The paragraph hook can see its images before or after the image hook has made them islands (it depends on the options): match both.
const IMAGE_ISLANDS = new RegExp(`<img data-markdown="img"[^>]*>|<span data-words-island="${IMAGE}"[^>]*><span data-words-island-content></span><span data-words-island-fallback></span></span>`, "g")

const str = (value: unknown) => (typeof value === "string" ? value : "")

// Words renders into the container itself (no ref, no children) and uses the animation callbacks for its stream.
type MarkdownProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "dangerouslySetInnerHTML" | "onAnimationStart" | "onAnimationEnd"> & {
  children?: string
  /** True while the text is still streaming in: unfinished emphasis, code and links render as if closed, unfinished images wait. */
  isAnimating?: boolean
  /** Draws fenced code blocks. Pass a module-level component: a new one redraws the message. */
  codeBlock?: React.ComponentType<MarkdownCodeBlockProps>
  /** Draws images. Pass a module-level component: a new one redraws the message. */
  image?: React.ComponentType<MarkdownImageProps>
}

function Markdown({ className, children = "", isAnimating = false, codeBlock: Code = MarkdownCodeBlock, image: Image = MarkdownImage, ...props }: MarkdownProps) {
  const islands = React.useMemo<ReactiveIslands>(
    () => ({
      [CODE]: { render: (d) => <Code code={str(d.code)} language={str(d.language)} incomplete={d.incomplete === true} /> },
      [IMAGE]: { inline: true, render: (d) => <Image src={str(d.src)} alt={str(d.alt)} /> },
    }),
    [Code, Image],
  )
  return (
    <Words
      data-slot="markdown"
      isAnimating={isAnimating}
      components={COMPONENTS}
      plugins={PLUGINS}
      islands={islands}
      urlTransform={urlTransform}
      controls={false}
      lineNumbers={false}
      className={cn("cn-markdown w-full min-w-0 space-y-4 overflow-hidden whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      {...props}
    >
      {children}
    </Words>
  )
}

export { Markdown, type MarkdownCodeBlockProps, type MarkdownImageProps }
