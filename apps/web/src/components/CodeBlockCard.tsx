import { useMemo } from 'react'
import { File, PatchDiff } from './diffs'
import { markdownPatch } from '../lib/markdownPatch'
import { useTheme } from 'next-themes'
import { useIsCodeFenceIncomplete, type ExtraProps } from 'streamdown'
import { cn } from 'cn'
import { CodeBlockCopyButton } from '@dorks/ui/code-block'

const LANG_EXT: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  markdown: 'md',
  yaml: 'yml',
  rust: 'rs',
  ruby: 'rb',
  csharp: 'cs',
  'c#': 'cs',
  'c++': 'cpp',
  plaintext: 'txt',
  text: 'txt',
}

function fileNameFor(language: string) {
  const clean = language.trim().toLowerCase()
  if (!clean) return 'code.txt'
  const ext = LANG_EXT[clean] ?? clean
  return `code.${ext}`
}

// Balanced padding inside the inner white card when line numbers and the file header are hidden;
// Pierre's line content already adds horizontal inset, so 4px aligns the code edge with the header label.
const CODE_CSS = '[data-code] { padding-block: 10px; padding-inline: 4px; }'

/**
 * Fenced code block for markdown: a card-on-card layout (muted outer frame with header + copy button,
 * concentric 6px inner surface card) highlighted with Pierre (`@pierre/diffs/react`).
 */
export function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  const incomplete = useIsCodeFenceIncomplete()
  const { resolvedTheme } = useTheme()
  const trimmed = code.replace(/\n$/, '')
  const file = useMemo(() => ({ name: fileNameFor(language), contents: trimmed }), [language, trimmed])
  // A `diff` / `patch` fence is drawn as a diff (Pierre's add/remove fills and gutter marks), not as text coloured by its +/-.
  const patch = useMemo(() => (language === 'diff' || language === 'patch' ? markdownPatch(trimmed) : null), [language, trimmed])
  const options = useMemo(
    () => ({
      disableFileHeader: true,
      disableLineNumbers: !patch?.numbered,
      overflow: 'scroll' as const,
      themeType: (resolvedTheme === 'dark' ? 'dark' : 'light') as 'dark' | 'light',
      unsafeCSS: CODE_CSS,
    }),
    [resolvedTheme, patch?.numbered],
  )
  const fallback = <pre className="overflow-x-auto px-4 py-2.5 font-mono text-xs leading-5">{trimmed}</pre>
  const surface = 'block [--diffs-bg:var(--surface)] [--diffs-font-family:var(--font-mono)] [--diffs-font-size:12px] [--diffs-line-height:20px] dark:[--diffs-bg:var(--background)]'

  return (
    <div className="my-4 overflow-hidden rounded-[10px] border border-border bg-muted dark:bg-card">
      <div className="flex h-8 items-center justify-between pr-1.5 pl-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium">{language || 'text'}</span>
        <CodeBlockCopyButton value={trimmed} disabled={incomplete} className="size-6 rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground" />
      </div>
      <div className="-mx-px -mb-px overflow-hidden rounded-[10px] border border-border bg-surface dark:bg-background">
        {/* Plain text in the same box until Pierre has loaded (only the first code block after the app starts waits for it). */}
        {patch ? (
          <PatchDiff
            patch={patch.patch}
            options={{ ...options, diffStyle: 'unified', hunkSeparators: 'simple', overflow: 'wrap', lineDiffType: patch.numbered ? 'word-alt' : 'none' }}
            // A sketch's lines are not edits of one another: no word-level pairing, which needs the diff off the shared worker pool.
            pool={patch.numbered}
            fallback={fallback}
            className={surface}
          />
        ) : (
          <File file={file} options={options} fallback={fallback} className={surface} />
        )}
      </div>
    </div>
  )
}

export function AgentCode({ node: _node, className, children, ...props }: React.ComponentProps<'code'> & ExtraProps) {
  if (!('data-block' in props)) {
    return (
      <code className={cn('rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)} {...props}>
        {children}
      </code>
    )
  }
  return <MarkdownCodeBlock code={typeof children === 'string' ? children : ''} language={/language-(\S+)/.exec(className ?? '')?.[1] ?? ''} />
}
