export interface SkillCatalogEntry {
  name: string
  group: SkillGroupId
  source: string
  author: string
  description: string
}

export const SKILL_GROUPS = [
  { id: 'design', title: 'Design & UI' },
  { id: 'documents', title: 'Documents & Media' },
  { id: 'engineering', title: 'Engineering & Testing' },
] as const

export type SkillGroupId = (typeof SKILL_GROUPS)[number]['id']

export const SKILL_CATALOG: SkillCatalogEntry[] = [
  // Design & UI
  {
    name: 'frontend-design',
    group: 'design',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Create distinctive, production-grade web interfaces with high design quality',
  },
  {
    name: 'vercel-react-best-practices',
    group: 'design',
    source: 'vercel-labs/agent-skills',
    author: 'Vercel',
    description: 'React and Next.js performance, data fetching and rendering patterns',
  },
  {
    name: 'web-design-guidelines',
    group: 'design',
    source: 'vercel-labs/agent-skills',
    author: 'Vercel',
    description: 'Review UI accessibility, layout consistency and web interface polish',
  },
  {
    name: 'canvas-design',
    group: 'design',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Generate posters, diagrams and visual assets with crisp typography',
  },
  // Documents & Media
  {
    name: 'pdf',
    group: 'documents',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Extract text, fill forms, merge and generate structured PDF documents',
  },
  {
    name: 'docx',
    group: 'documents',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Create, edit and review Word documents with tracked changes and formatting',
  },
  {
    name: 'xlsx',
    group: 'documents',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Build and analyze spreadsheets with formulas, charts and clean styling',
  },
  {
    name: 'pptx',
    group: 'documents',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Draft and edit presentation decks with consistent slide layouts',
  },
  // Engineering & Testing
  {
    name: 'webapp-testing',
    group: 'engineering',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Verify running web applications with Playwright scripts and visual checks',
  },
  {
    name: 'mcp-builder',
    group: 'engineering',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Design, implement and test Model Context Protocol servers and tools',
  },
  {
    name: 'skill-creator',
    group: 'engineering',
    source: 'anthropics/skills',
    author: 'Anthropic',
    description: 'Author, package and evaluate reusable agent skills with SKILL.md',
  },
  {
    name: 'supabase-postgres-best-practices',
    group: 'engineering',
    source: 'supabase/agent-skills',
    author: 'Supabase',
    description: 'Schema design, indexing, RLS policies and query optimization for Postgres',
  },
]

export const skillCatalogByName = (name: string) => SKILL_CATALOG.find((s) => s.name === name)
