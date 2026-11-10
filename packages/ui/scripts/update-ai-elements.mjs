// Re-clones the shadcn AI Elements patterns into src/components/ai-elements from the published docs, unmodified except for
// import paths (`@/...` -> this package's `#...` aliases). See README.md. Usage: node scripts/update-ai-elements.mjs [ref]
// `ref` is a shadcn-ui/ui commit or branch used for the docs-site helper files (default: main).
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const ref = process.argv[2] ?? "main"
const DOCS = "https://ui.shadcn.com/docs/ai-elements"
const RAW = `https://raw.githubusercontent.com/shadcn-ui/ui/${ref}/apps/v4`

const rewrite = (s) =>
  s
    .replaceAll('"@/components/ui/', '"#ui/')
    .replaceAll('"@/lib/ai"', '"#lib/ai"')
    .replaceAll('"@/lib/message-animations"', '"#lib/message-animations"')
    .replaceAll('"@/components/markdown"', '"#markdown"')
    .replaceAll('"@/registry/bases/base/hooks/use-highlighted-code"', '"#hooks/use-highlighted-code"')
    .replaceAll('"@/styles/base-rhea/ui/code-block"', '"#ui/code-block"')

const get = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

// The pattern list comes from the docs index, so new patterns are picked up automatically.
const index = await get(`${DOCS}.md`)
const names = [...new Set([...index.matchAll(/href="\/docs\/ai-elements\/base\/([a-z-]+)"/g)].map((m) => m[1]))].sort()

await mkdir(join(root, "src/components/ai-elements"), { recursive: true })
for (const name of names) {
  const page = await get(`${DOCS}/base/${name}.md`)
  const code = page.match(/```tsx\n([\s\S]*?)\n```/)?.[1]
  if (!code) throw new Error(`no tsx block in ${name}`)
  const out = rewrite(code) + "\n"
  const left = out.match(/"@\/[^"]+"/g)
  if (left) throw new Error(`${name}: unmapped imports ${[...new Set(left)].join(", ")}`)
  await writeFile(join(root, `src/components/ai-elements/${name}.tsx`), out)
}

// Docs-site helpers the patterns import.
await writeFile(join(root, "src/components/markdown.tsx"), rewrite(await get(`${RAW}/components/markdown.tsx`)))
await writeFile(join(root, "src/lib/ai.ts"), await get(`${RAW}/lib/ai.ts`))
await writeFile(join(root, "src/lib/message-animations.ts"), await get(`${RAW}/lib/message-animations.ts`))
console.log(`cloned ${names.length} patterns: ${names.join(", ")}`)
