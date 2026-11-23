/**
 * A ```diff (or ```patch) fence as a unified patch Pierre can draw. A real patch (with `@@` hunks) is kept, given file headers if it
 * lacks them, and keeps its line numbers. A loose sketch (lines marked `+` / `-`, the rest context) becomes one hunk with no line
 * numbers, which would mean nothing there. Null when it has no added or removed line: it is drawn as plain code.
 */
export function markdownPatch(code: string): { patch: string; numbered: boolean } | null {
  const lines = code.replace(/\n+$/, '').split('\n')
  if (lines.some((l) => /^@@ -\d/.test(l))) {
    const headed = lines.some((l) => l.startsWith('--- ')) && lines.some((l) => l.startsWith('+++ '))
    return { patch: `${headed ? '' : '--- a/file\n+++ b/file\n'}${lines.join('\n')}\n`, numbered: true }
  }
  if (!lines.some((l) => /^[+-]/.test(l))) return null
  let before = 0
  let after = 0
  const body = lines.map((line) => {
    if (line.startsWith('+')) return (after++, line)
    if (line.startsWith('-')) return (before++, line)
    before++
    after++
    return line.startsWith(' ') ? line : ` ${line}`
  })
  return { patch: `--- a/file\n+++ b/file\n@@ -1,${before} +1,${after} @@\n${body.join('\n')}\n`, numbered: false }
}
