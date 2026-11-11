"use client"

import * as React from "react"
import { cn } from "cn"
import {
  Streamdown,
  useIsCodeFenceIncomplete,
  type ExtraProps,
} from "streamdown"

import { useHighlightedCode } from "#hooks/use-highlighted-code"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "#ui/code-block"

function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string
  language: string
}) {
  // True while the closing fence has not arrived yet.
  const incomplete = useIsCodeFenceIncomplete()
  const lines = useHighlightedCode(code, language)

  // The ring is inset: the markdown container clips overflow, which cut an outer ring to its top edge. No line numbers, as in the
  // published Markdown example, so the code starts on the title's edge. Its own 16px above and below: the container's space-y-4
  // only spaces top-level blocks, so a fence inside a list item sat flush against the text around it (the margins collapse with
  // space-y-4 at the top level, and the container's first/last-child rules still zero them at its edges).
  return (
    <CodeBlock className="my-4 ring-inset">
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

function MarkdownCode({
  node,
  className,
  children,
  ...props
}: React.ComponentProps<"code"> & ExtraProps) {
  // Streamdown marks fenced code with data-block. Inline code stays inline.
  if (!("data-block" in props)) {
    return (
      <code
        className={cn(
          "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]",
          className
        )}
        {...props}
      >
        {children}
      </code>
    )
  }

  return (
    <MarkdownCodeBlock
      code={typeof children === "string" ? children : ""}
      language={/language-(\S+)/.exec(className ?? "")?.[1] ?? ""}
    />
  )
}

// Streamdown memoizes on components, so keep the default stable. Exported so an app can add its own (an `img` override, say) and
// keep the code blocks: spread it into a module-level object.
const DEFAULT_COMPONENTS = { code: MarkdownCode }

function Markdown({
  className,
  components = DEFAULT_COMPONENTS,
  controls = false,
  ...props
}: React.ComponentProps<typeof Streamdown>) {
  return (
    <Streamdown
      data-slot="markdown"
      components={components}
      controls={controls}
      className={cn("cn-markdown w-full min-w-0 overflow-hidden", className)}
      {...props}
    />
  )
}

export { defaultRehypePlugins, defaultUrlTransform } from "streamdown"
export { Markdown, DEFAULT_COMPONENTS as markdownComponents }
