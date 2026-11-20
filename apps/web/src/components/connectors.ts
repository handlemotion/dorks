import type { McpServerInput } from '@dorks/client'
import {
  siAirtable,
  siAsana,
  siBrave,
  siCalendly,
  siClickup,
  siCloudflare,
  siConfluence,
  siDiscord,
  siDropbox,
  siFigma,
  siGmail,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siHubspot,
  siIntercom,
  siJira,
  siLinear,
  siMiro,
  siNeon,
  siNotion,
  siPosthog,
  siRender,
  siSentry,
  siStripe,
  siSupabase,
  siTrello,
  siZendesk,
  siZoom,
} from 'simple-icons'

// The connector catalog in Customize (docs/mcp.md). Two kinds:
// - a key connector is a vendor MCP server that takes a static token: it saves an ordinary MCP server named after its `id`, so it
//   shows as connected when a server with that name exists;
// - a Composio app (`toolkit`) only signs in with OAuth, which a sandbox cannot finish: the owner signs in once in a browser through
//   Composio, and agents reach it through the one `composio` server.

export type Connector = KeyConnector | ComposioApp

/** The sections the catalog is shown in, in order. */
export const KINDS = [
  { id: 'engineering', title: 'Engineering' },
  { id: 'research', title: 'Web and docs' },
  { id: 'planning', title: 'Planning' },
  { id: 'design', title: 'Design' },
  { id: 'communication', title: 'Communication' },
  { id: 'files', title: 'Docs and files' },
  { id: 'customers', title: 'Customers' },
] as const
export type Kind = (typeof KINDS)[number]['id']

interface Base {
  id: string
  kind: Kind
  name: string
  by: string
  description: string
  /** A 24×24 path (simple-icons, or our own below) and brand colour; a monogram when there is none. */
  icon?: { path: string; hex: string; evenodd?: boolean }
}
export interface KeyConnector extends Base {
  toolkit?: undefined
  /** What the key is called where you get it, and where that is. */
  keyLabel: string
  keyUrl: string
  /** The server to save for a key. */
  server: (key: string) => McpServerInput
}
export interface ComposioApp extends Base {
  /** Composio's toolkit slug. */
  toolkit: string
}

/** The Composio key, saved as the `composio` MCP server. */
export const COMPOSIO = { id: 'composio', keyLabel: 'API key', keyUrl: 'https://platform.composio.dev/settings' } as const

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

const SLACK = {
  hex: '4A154B',
  path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
}

const app = (kind: Kind, toolkit: string, name: string, description: string, mark?: { path: string; hex: string }): ComposioApp => ({
  id: `composio-${toolkit}`,
  kind,
  toolkit,
  name,
  by: name,
  description,
  icon: mark && icon(mark),
})

export const CONNECTORS: Connector[] = [
  // Engineering
  {
    id: 'sentry',
    kind: 'engineering',
    name: 'Sentry',
    by: 'Sentry',
    description: 'Read issues, stack traces and releases to debug production errors',
    icon: icon(siSentry),
    keyLabel: 'User auth token',
    keyUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    server: bearer('https://mcp.sentry.dev/mcp', 'Sentry-Bearer'),
  },
  {
    id: 'posthog',
    kind: 'engineering',
    name: 'PostHog',
    by: 'PostHog',
    description: 'Query product analytics, feature flags and experiments',
    icon: icon(siPosthog),
    keyLabel: 'Personal API key',
    keyUrl: 'https://app.posthog.com/settings/user-api-keys',
    server: bearer('https://mcp.posthog.com/mcp'),
  },
  {
    id: 'cloudflare',
    kind: 'engineering',
    name: 'Cloudflare',
    by: 'Cloudflare',
    description: 'Workers, DNS, R2, D1 and the rest of the Cloudflare API',
    icon: icon(siCloudflare),
    keyLabel: 'API token',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    server: bearer('https://mcp.cloudflare.com/mcp'),
  },
  {
    id: 'render',
    kind: 'engineering',
    name: 'Render',
    by: 'Render',
    description: 'Services, deploys, logs and metrics on Render',
    icon: icon(siRender),
    keyLabel: 'API key',
    keyUrl: 'https://dashboard.render.com/u/settings?add-api-key',
    server: bearer('https://mcp.render.com/mcp'),
  },
  {
    id: 'supabase',
    kind: 'engineering',
    name: 'Supabase',
    by: 'Supabase',
    description: 'Manage databases, run SQL, and read logs and project settings',
    icon: icon(siSupabase),
    keyLabel: 'Personal access token',
    keyUrl: 'https://supabase.com/dashboard/account/tokens',
    server: npx('@supabase/mcp-server-supabase@latest', 'SUPABASE_ACCESS_TOKEN'),
  },
  {
    id: 'neon',
    kind: 'engineering',
    name: 'Neon',
    by: 'Neon',
    description: 'Create branches, run SQL and manage Postgres projects',
    icon: icon(siNeon),
    keyLabel: 'API key',
    keyUrl: 'https://console.neon.tech/app/settings/api-keys',
    server: bearer('https://mcp.neon.tech/mcp'),
  },
  // Web and docs
  {
    id: 'context7',
    kind: 'research',
    name: 'Context7',
    by: 'Upstash',
    description: 'Current documentation and code examples for any library',
    icon: CONTEXT7,
    keyLabel: 'API key',
    keyUrl: 'https://context7.com/dashboard',
    server: (key) => ({ transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: key } }),
  },
  {
    id: 'firecrawl',
    kind: 'research',
    name: 'Firecrawl',
    by: 'Firecrawl',
    description: 'Search the web and scrape pages into clean markdown',
    icon: FIRECRAWL,
    keyLabel: 'API key',
    keyUrl: 'https://www.firecrawl.dev/app/api-keys',
    server: bearer('https://mcp.firecrawl.dev/v2/mcp'),
  },
  {
    id: 'exa',
    kind: 'research',
    name: 'Exa',
    by: 'Exa',
    description: 'Search the web and code, and fetch pages',
    keyLabel: 'API key',
    keyUrl: 'https://dashboard.exa.ai/api-keys',
    server: (key) => ({ transport: 'http', url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': key } }),
  },
  {
    id: 'brave-search',
    kind: 'research',
    name: 'Brave Search',
    by: 'Brave',
    description: 'Web, news, image and local search',
    icon: icon(siBrave),
    keyLabel: 'API key',
    keyUrl: 'https://api-dashboard.search.brave.com/app/keys',
    server: npx('@brave/brave-search-mcp-server', 'BRAVE_API_KEY'),
  },
  {
    id: 'apify',
    kind: 'research',
    name: 'Apify',
    by: 'Apify',
    description: 'Run scrapers and crawlers from the Apify Store',
    keyLabel: 'API token',
    keyUrl: 'https://console.apify.com/settings/integrations',
    server: bearer('https://mcp.apify.com'),
  },
  // Planning
  {
    id: 'linear',
    kind: 'planning',
    name: 'Linear',
    by: 'Linear',
    description: 'Find, create and update issues, projects and comments',
    icon: icon(siLinear),
    keyLabel: 'API key',
    keyUrl: 'https://linear.app/settings/account/security',
    server: bearer('https://mcp.linear.app/mcp'),
  },
  app('planning', 'jira', 'Jira', 'Search, create and update issues', siJira),
  app('planning', 'asana', 'Asana', 'Tasks, projects and comments', siAsana),
  app('planning', 'trello', 'Trello', 'Boards, lists and cards', siTrello),
  app('planning', 'clickup', 'ClickUp', 'Tasks, lists and docs', siClickup),
  app('planning', 'googlecalendar', 'Google Calendar', 'See and schedule events', siGooglecalendar),
  app('planning', 'calendly', 'Calendly', 'Event types, bookings and availability', siCalendly),
  // Design
  app('design', 'figma', 'Figma', 'Read files, frames, components and comments', siFigma),
  app('design', 'canva', 'Canva', 'Find, create and export designs'),
  app('design', 'miro', 'Miro', 'Read and add to boards', siMiro),
  // Communication
  app('communication', 'slack', 'Slack', 'Read channels and threads, and post messages', SLACK),
  app('communication', 'gmail', 'Gmail', 'Search, read and draft email', siGmail),
  app('communication', 'outlook', 'Outlook', 'Mail, calendar and contacts'),
  app('communication', 'microsoft_teams', 'Microsoft Teams', 'Chats, channels and meetings'),
  app('communication', 'discord', 'Discord', 'Servers, channels and messages', siDiscord),
  app('communication', 'zoom', 'Zoom', 'Meetings and recordings', siZoom),
  // Docs and files
  {
    id: 'notion',
    kind: 'files',
    name: 'Notion',
    by: 'Notion',
    description: 'Search, read and update pages and databases in your workspace',
    icon: icon(siNotion),
    keyLabel: 'Integration secret',
    keyUrl: 'https://www.notion.so/profile/integrations',
    server: npx('@notionhq/notion-mcp-server', 'NOTION_TOKEN'),
  },
  app('files', 'googledocs', 'Google Docs', 'Read, write and comment on documents', siGoogledocs),
  app('files', 'googlesheets', 'Google Sheets', 'Read and update spreadsheets', siGooglesheets),
  app('files', 'googledrive', 'Google Drive', 'Find, read and organise files', siGoogledrive),
  app('files', 'confluence', 'Confluence', 'Search, read and write pages', siConfluence),
  app('files', 'airtable', 'Airtable', 'Bases, tables and records', siAirtable),
  app('files', 'dropbox', 'Dropbox', 'Find, read and share files', siDropbox),
  // Customers
  {
    id: 'stripe',
    kind: 'customers',
    name: 'Stripe',
    by: 'Stripe',
    description: 'Customers, payments, subscriptions and the Stripe docs',
    icon: icon(siStripe),
    keyLabel: 'Restricted API key',
    keyUrl: 'https://dashboard.stripe.com/apikeys',
    server: bearer('https://mcp.stripe.com'),
  },
  app('customers', 'hubspot', 'HubSpot', 'Contacts, companies and deals', siHubspot),
  app('customers', 'salesforce', 'Salesforce', 'Accounts, contacts and opportunities'),
  app('customers', 'intercom', 'Intercom', 'Conversations, contacts and help articles', siIntercom),
  app('customers', 'zendesk', 'Zendesk', 'Tickets, users and help center articles', siZendesk),
]

/** The key connector saved under this server name, if any. */
export const connectorById = (id: string) => CONNECTORS.find((c): c is KeyConnector => !c.toolkit && c.id === id)
