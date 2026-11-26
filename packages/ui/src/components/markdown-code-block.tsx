"use client"

import { useHighlightedCode } from "#hooks/use-highlighted-code"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "#ui/code-block"

/** A fenced code block: its code (no trailing newline), the fence's language (`""` when it has none), and whether the fence is still open. */
type MarkdownCodeBlockProps = { code: string; language: string; incomplete: boolean }

/** Markdown's own code block, highlighted with Shiki. Loaded on its own (`markdown.tsx`): an app that draws fences itself never loads Shiki. */
export default function MarkdownCodeBlock({ code, language, incomplete }: MarkdownCodeBlockProps) {
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
