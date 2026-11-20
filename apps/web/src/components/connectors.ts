import type { McpServerInput } from '@dorks/client'
import { siCloudflare, siLinear, siNeon, siNotion, siPosthog, siSentry, siStripe, siSupabase } from 'simple-icons'

// The connector catalog in Customize (docs/mcp.md): popular MCP servers that a sandbox can reach without a browser, each set up from
// one key. A connector saves an ordinary MCP server named after its `id`, so it shows as connected when a server with that name exists.
// Only servers that accept a static token belong here: a sandbox has no one to finish an OAuth sign-in.

export interface Connector {
  id: string
  name: string
  by: string
  description: string
  /** A 24×24 path (simple-icons, or our own below) and brand colour; a monogram when there is none. */
  icon?: { path: string; hex: string; evenodd?: boolean }
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

// Marks simple-icons lacks. Firecrawl's flame is from @lobehub/icons; Context7's is its tile with the bracket glyph cut out.
const FIRECRAWL = {
  hex: 'FF4D00',
  path: 'M18.183 7.67c-.939.278-1.647.905-2.166 1.586-.11.146-.343.036-.299-.143.993-4.058-.318-7.432-4.407-9.092a.272.272 0 00-.368.317C12.803 7.76 4.98 7.135 5.969 15.55a.17.17 0 01-.266.159c-.37-.265-.784-.817-1.068-1.205a.17.17 0 00-.302.054A8.631 8.631 0 004 16.9a8.43 8.43 0 003.843 7.07c.133.086.303-.038.258-.189a4.533 4.533 0 01-.133-2.041c.097-.637.32-1.244.694-1.797 1.283-1.914 3.854-3.763 3.443-6.273-.026-.16.162-.264.281-.155 1.812 1.645 2.17 3.858 1.873 5.844-.026.172.192.264.302.129.277-.345.615-.647.983-.875a.17.17 0 01.25.088c.204.592.508 1.148.796 1.704a4.528 4.528 0 01.307 3.375.17.17 0 00.257.192A8.43 8.43 0 0021 16.9a8.746 8.746 0 00-.524-2.98c-.718-1.982-2.54-3.47-2.08-6.053a.17.17 0 00-.213-.195z',
}
const CONTEXT7 = {
  hex: '000000',
  evenodd: true,
  path:
    'M6 1h12a5 5 0 015 5v12a5 5 0 01-5 5H6a5 5 0 01-5-5V6a5 5 0 015-5z' +
    'M6 6h5v1.2L9.6 9v3H7.4V9L6 7.2zM7.4 13h2.2v3l1.4 1.8V19H6v-1.2L7.4 16z' +
    'M13 6h5v1.2L16.6 9v3h-2.2V9L13 7.2zM14.4 13h2.2v3l1.4 1.8V19h-5v-1.2l1.4-1.8z',
}

export const CONNECTORS: Connector[] = [
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
    icon: FIRECRAWL,
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
    icon: CONTEXT7,
    keyLabel: 'API key',
    keyUrl: 'https://context7.com/dashboard',
    server: (key) => ({ transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: key } }),
  },
]

export const connectorById = (id: string) => CONNECTORS.find((c) => c.id === id)
