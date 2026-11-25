// What's new: the desktop app's release notes (apps/desktop/CHANGELOG.md, written by changesets), bundled at build time so the menu
// needs no request. Each release is shown by its headline change.
import raw from '../../../desktop/CHANGELOG.md?raw'

export const REPO_URL = 'https://github.com/handlemotion/dorks'
export const CHANGELOG_URL = `${REPO_URL}/blob/main/apps/desktop/CHANGELOG.md`
export const releaseUrl = (version: string) => `${REPO_URL}/releases/tag/desktop-v${version}`

export type Release = { version: string; headline: string; url: string }

// A changeset line: `- [#224](…) [\`47c9460\`](…) Thanks [@someone](…)! - The text.` The links before the text are optional.
const ENTRY = /^- (?:\[#\d+\]\([^)]*\) )?(?:\[`[0-9a-f]+`\]\([^)]*\) )?(?:Thanks \[@[^\]]*\]\([^)]*\)! - )?(.*)$/

/** A change's headline: the words before its colon when they make a short title (`Comment on images: …`), else its first sentence. */
export function headlineOf(text: string): string {
  const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '')
  const colon = plain.indexOf(': ')
  if (colon > 0 && colon <= 48) return plain.slice(0, colon)
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain
  return sentence.replace(/\.$/, '')
}

/** The releases in `markdown`, newest first: each `## x.y.z` with its first change (minor changes come first in the file). */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = []
  for (const section of markdown.split(/^## /m).slice(1)) {
    const [heading, ...lines] = section.split('\n')
    const version = heading.trim()
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    const first = lines.find((l) => l.startsWith('- '))
    const text = first ? ENTRY.exec(first)?.[1] : undefined
    if (text) releases.push({ version, headline: headlineOf(text), url: releaseUrl(version) })
  }
  return releases
}

export const RELEASES = parseChangelog(raw)
