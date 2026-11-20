import type { McpServerInput } from '@dorks/client'
import { siCloudflare, siGithub, siLinear, siNeon, siNotion, siPosthog, siSentry, siStripe, siSupabase } from 'simple-icons'

// The connector catalog in Customize (docs/mcp.md): popular MCP servers that a sandbox can reach without a browser, each set up from
// one key. A connector saves an ordinary MCP server named after its `id`, so it shows as connected when a server with that name exists.
// Only servers that accept a static token belong here: a sandbox has no one to finish an OAuth sign-in.

export interface Connector {
  id: string
  name: string
  by: string
  description: string
  /** A simple-icons path (24×24) and brand colour; a monogram when there is none. */
  icon?: { path: string; hex: string }
  /** What the key is called where you get it, and where that is. */
  keyLabel: string
  keyUrl: string
  /** The server to save for a key. */
  server: (key: string) => McpServerInput
}

const bearer =
  (url: string, scheme = 'Bearer') =>
  (key: string): McpServerInput => ({ transport: 'http', url, headers: { Authorization: `${scheme} ${key}` } })
const npx =
  (pkg: string, envName: string, args: string[] = []) =>
  (key: string): McpServerInput => ({ transport: 'stdio', command: 'npx', args: ['-y', pkg, ...args], env: { [envName]: key } })
const icon = (s: { path: string; hex: string }) => ({ path: s.path, hex: s.hex })

export const CONNECTORS: Connector[] = [
  {
    id: 'github',
    name: 'GitHub',
    by: 'GitHub',
    description: 'Issues, pull requests, Actions and code search across repositories',
    icon: icon(siGithub),
    keyLabel: 'Personal access token',
    keyUrl: 'https://github.com/settings/personal-access-tokens',
    server: bearer('https://api.githubcopilot.com/mcp/'),
  },
  {
    id: 'linear',
    name: 'Linear',
    by: 'Linear',
    description: 'Find, create and update issues, projects and comments',
    icon: icon(siLinear),
    keyLabel: 'API key',
    keyUrl: 'https://linear.app/settings/account/security',
    server: bearer('https://mcp.linear.app/mcp'),
  },
  {
    id: 'sentry',
    name: 'Sentry',
    by: 'Sentry',
    description: 'Read issues, stack traces and releases to debug production errors',
    icon: icon(siSentry),
    keyLabel: 'User auth token',
    keyUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    server: bearer('https://mcp.sentry.dev/mcp', 'Sentry-Bearer'),
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    by: 'Cloudflare',
    description: 'Workers, DNS, R2, D1 and the rest of the Cloudflare API',
    icon: icon(siCloudflare),
    keyLabel: 'API token',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    server: bearer('https://mcp.cloudflare.com/mcp'),
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    by: 'Firecrawl',
    description: 'Search the web and scrape pages into clean markdown',
    keyLabel: 'API key',
    keyUrl: 'https://www.firecrawl.dev/app/api-keys',
    server: bearer('https://mcp.firecrawl.dev/v2/mcp'),
  },
  {
    id: 'notion',
    name: 'Notion',
    by: 'Notion',
    description: 'Search, read and update pages and databases in your workspace',
    icon: icon(siNotion),
    keyLabel: 'Integration secret',
    keyUrl: 'https://www.notion.so/profile/integrations',
    server: npx('@notionhq/notion-mcp-server', 'NOTION_TOKEN'),
  },
  {
    id: 'supabase',
    name: 'Supabase',
    by: 'Supabase',
    description: 'Manage databases, run SQL, and read logs and project settings',
    icon: icon(siSupabase),
    keyLabel: 'Personal access token',
    keyUrl: 'https://supabase.com/dashboard/account/tokens',
    server: npx('@supabase/mcp-server-supabase@latest', 'SUPABASE_ACCESS_TOKEN'),
  },
  {
    id: 'stripe',
    name: 'Stripe',
    by: 'Stripe',
    description: 'Customers, payments, subscriptions and the Stripe docs',
    icon: icon(siStripe),
    keyLabel: 'Restricted API key',
    keyUrl: 'https://dashboard.stripe.com/apikeys',
    server: bearer('https://mcp.stripe.com'),
  },
  {
    id: 'posthog',
    name: 'PostHog',
    by: 'PostHog',
    description: 'Query product analytics, feature flags and experiments',
    icon: icon(siPosthog),
    keyLabel: 'Personal API key',
    keyUrl: 'https://app.posthog.com/settings/user-api-keys',
    server: bearer('https://mcp.posthog.com/mcp'),
  },
  {
    id: 'neon',
    name: 'Neon',
    by: 'Neon',
    description: 'Create branches, run SQL and manage Postgres projects',
    icon: icon(siNeon),
    keyLabel: 'API key',
    keyUrl: 'https://console.neon.tech/app/settings/api-keys',
    server: bearer('https://mcp.neon.tech/mcp'),
  },
  {
    id: 'context7',
    name: 'Context7',
    by: 'Upstash',
    description: 'Current documentation and code examples for any library',
    keyLabel: 'API key',
    keyUrl: 'https://context7.com/dashboard',
    server: (key) => ({ transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: key } }),
  },
]

export const connectorById = (id: string) => CONNECTORS.find((c) => c.id === id)
