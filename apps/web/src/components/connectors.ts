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

const EXA = {
  hex: '1F40ED',
  evenodd: true,
  path: 'M3 0h19v1.791L13.892 12 22 22.209V24H3V0zm9.62 10.348l6.589-8.557H6.03l6.59 8.557zM5.138 3.935v7.17h5.52l-5.52-7.17zm5.52 8.96h-5.52v7.17l5.52-7.17zM6.03 22.21l6.59-8.557 6.589 8.557H6.03z',
}

const APIFY = {
  hex: '246DFF',
  path: 'M13.51 1.74H21.95C22.12 1.74 22.26 1.88 22.26 2.05V14.95C22.26 15.26 21.86 15.38 21.69 15.12L13.25 2.22C13.11 2.01 13.26 1.74 13.51 1.74ZM10.49 1.74H2.05C1.88 1.74 1.74 1.88 1.74 2.05V14.95C1.74 15.26 2.14 15.38 2.31 15.12L10.75 2.22C10.89 2.01 10.74 1.74 10.49 1.74ZM11.86 12.07L2.26 21.73C2.07 21.93 2.21 22.26 2.49 22.26H21.52C21.8 22.26 21.94 21.93 21.75 21.73L12.3 12.07C12.18 11.95 11.98 11.95 11.86 12.07Z',
}

const CANVA = {
  hex: '00C4CC',
  path: 'M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zM6.962 7.68c.754 0 1.337.549 1.405 1.2.069.583-.171 1.097-.822 1.406-.343.171-.48.172-.549.069-.034-.069 0-.137.069-.206.617-.514.617-.926.548-1.508-.034-.378-.308-.618-.583-.618-1.2 0-2.914 2.674-2.674 4.629.103.754.549 1.646 1.509 1.646.308 0 .65-.103.96-.24.5-.264.799-.47 1.097-.8-.073-.885.704-2.046 1.851-2.046.515 0 .926.205.96.583.068.514-.377.582-.514.582s-.378-.034-.378-.17c-.034-.138.309-.07.275-.378-.035-.206-.24-.274-.446-.274-.72 0-1.131.994-1.029 1.611.035.275.172.549.447.549.205 0 .514-.31.617-.755.068-.308.343-.514.583-.514.102 0 .17.034.205.171v.138c-.034.137-.137.548-.102.651 0 .069.034.171.17.171.092 0 .436-.18.777-.459.117-.59.253-1.298.253-1.357.034-.24.137-.48.617-.48.103 0 .171.034.205.171v.138l-.136.617c.445-.583 1.097-.994 1.508-.994.172 0 .309.102.309.274 0 .103 0 .274-.069.446-.137.377-.309.96-.412 1.474 0 .137.035.274.207.274.171 0 .685-.206 1.096-.754l.007-.004c-.002-.068-.007-.134-.007-.202 0-.411.035-.754.104-.994.068-.274.411-.514.617-.514.103 0 .205.069.205.171 0 .035 0 .103-.034.137-.137.446-.24.857-.24 1.269 0 .24.034.582.102.788 0 .034.035.069.07.069.068 0 .548-.445.89-1.028-.308-.206-.48-.549-.48-.96 0-.72.446-1.097.858-1.097.343 0 .617.24.617.72 0 .308-.103.65-.274.96h.102a.77.77 0 0 0 .584-.24.293.293 0 0 1 .134-.117c.335-.425.83-.74 1.41-.74.48 0 .924.205.959.582.068.515-.378.618-.515.618l-.002-.002c-.138 0-.377-.035-.377-.172 0-.137.309-.068.274-.376-.034-.206-.24-.275-.446-.275-.686 0-1.13.891-1.028 1.611.034.275.171.583.445.583.206 0 .515-.308.652-.754.068-.274.343-.514.583-.514.103 0 .17.034.205.171 0 .069 0 .206-.137.652-.17.308-.171.48-.137.617.034.274.171.48.309.583.034.034.068.102.068.102 0 .069-.034.138-.137.138-.034 0-.068 0-.103-.035-.514-.205-.72-.548-.789-.891-.205.24-.445.377-.72.377-.445 0-.89-.411-.96-.926a1.609 1.609 0 0 1 .075-.649c-.203.13-.422.203-.623.203h-.17c-.447.652-.927 1.098-1.27 1.303a.896.896 0 0 1-.377.104c-.068 0-.171-.035-.205-.104-.095-.152-.156-.392-.193-.667-.481.527-1.145.805-1.453.805-.343 0-.548-.206-.582-.55v-.376c.102-.754.377-1.2.377-1.337a.074.074 0 0 0-.069-.07c-.24 0-1.028.824-1.166 1.373l-.103.445c-.068.309-.377.515-.582.515-.103 0-.172-.035-.206-.172v-.137l.046-.233c-.435.31-.87.508-1.075.508-.308 0-.48-.172-.514-.412-.206.274-.445.412-.754.412-.352 0-.696-.24-.862-.593-.244.275-.523.553-.852.764-.48.309-1.028.549-1.68.549-.582 0-1.097-.309-1.371-.583-.412-.377-.651-.96-.686-1.509-.205-1.68.823-3.84 2.4-4.8.378-.205.755-.343 1.132-.343zm9.77 3.291c-.104 0-.172.172-.172.343 0 .274.137.583.309.755a1.74 1.74 0 0 0 .102-.583c0-.343-.137-.515-.24-.515z',
}

const OUTLOOK = {
  hex: '0078D4',
  path: 'M7.88 12.04q0 .45-.11.87-.1.41-.33.74-.22.33-.58.52-.37.2-.87.2t-.85-.2q-.35-.21-.57-.55-.22-.33-.33-.75-.1-.42-.1-.86t.1-.87q.1-.43.34-.76.22-.34.59-.54.36-.2.87-.2t.86.2q.35.21.57.55.22.34.31.77.1.43.1.88zM24 12v9.38q0 .46-.33.8-.33.32-.8.32H7.13q-.46 0-.8-.33-.32-.33-.32-.8V18H1q-.41 0-.7-.3-.3-.29-.3-.7V7q0-.41.3-.7Q.58 6 1 6h6.5V2.55q0-.44.3-.75.3-.3.75-.3h12.9q.44 0 .75.3.3.3.3.75V10.85l1.24.72h.01q.1.07.18.18.07.12.07.25zm-6-8.25v3h3v-3zm0 4.5v3h3v-3zm0 4.5v1.83l3.05-1.83zm-5.25-9v3h3.75v-3zm0 4.5v3h3.75v-3zm0 4.5v2.03l2.41 1.5 1.34-.8v-2.73zM9 3.75V6h2l.13.01.12.04v-2.3zM5.98 15.98q.9 0 1.6-.3.7-.32 1.19-.86.48-.55.73-1.28.25-.74.25-1.61 0-.83-.25-1.55-.24-.71-.71-1.24t-1.15-.83q-.68-.3-1.55-.3-.92 0-1.64.3-.71.3-1.2.85-.5.54-.75 1.3-.25.74-.25 1.63 0 .85.26 1.56.26.72.74 1.23.48.52 1.17.81.69.3 1.56.3zM7.5 21h12.39L12 16.08V17q0 .41-.3.7-.29.3-.7.3H7.5zm15-.13v-7.24l-5.9 3.54Z',
}

const MICROSOFT_TEAMS = {
  hex: '6264A7',
  path: 'M20.625 8.127q-.55 0-1.025-.205-.475-.205-.832-.563-.358-.357-.563-.832Q18 6.053 18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563.474-.205 1.025-.205.54 0 1.02.205t.837.563q.358.357.563.837.205.48.205 1.02 0 .55-.205 1.025-.205.475-.563.832-.357.358-.837.563-.48.205-1.02.205zm0-3.75q-.469 0-.797.328-.328.328-.328.797 0 .469.328.797.328.328.797.328.469 0 .797-.328.328-.328.328-.797 0-.469-.328-.797-.328-.328-.797-.328zM24 10.002v5.578q0 .774-.293 1.46-.293.685-.803 1.194-.51.51-1.195.803-.686.293-1.459.293-.445 0-.908-.105-.463-.106-.85-.329-.293.95-.855 1.729-.563.78-1.319 1.336-.756.557-1.67.861-.914.305-1.898.305-1.148 0-2.162-.398-1.014-.399-1.805-1.102-.79-.703-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5 0-.727.275-1.365.276-.639.75-1.114.475-.474 1.114-.75.638-.275 1.365-.275t1.365.275q.639.276 1.114.75.474.475.75 1.114.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113-.475.475-1.114.75-.638.276-1.365.276-.188 0-.375-.024-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328.328.328.328.797zM12.75 2.373q-.41 0-.78.158-.368.158-.638.434-.27.275-.428.639-.158.363-.158.773 0 .41.158.78.159.368.428.638.27.27.639.428.369.158.779.158.41 0 .773-.158.364-.159.64-.428.274-.27.433-.639.158-.369.158-.779 0-.41-.158-.773-.159-.364-.434-.64-.275-.275-.639-.433-.363-.158-.773-.158zM6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5.405.691.985 1.19.58.497 1.318.779.738.281 1.582.281.926 0 1.746-.352.82-.351 1.436-.966.615-.616.966-1.43.352-.815.352-1.752zm5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452.387.146.809.146.469 0 .879-.176.41-.175.715-.48.304-.305.48-.715t.176-.879Z',
}

const SALESFORCE = {
  hex: '00A1E0',
  path: 'M10.006 5.415a4.195 4.195 0 013.045-1.306c1.56 0 2.954.9 3.69 2.205.63-.3 1.35-.45 2.1-.45 2.85 0 5.159 2.34 5.159 5.22s-2.31 5.22-5.176 5.22c-.345 0-.69-.044-1.02-.104a3.75 3.75 0 01-3.3 1.95c-.6 0-1.155-.15-1.65-.375A4.314 4.314 0 018.88 20.4a4.302 4.302 0 01-4.05-2.82c-.27.062-.54.076-.825.076-2.204 0-4.005-1.8-4.005-4.05 0-1.5.811-2.805 2.01-3.51-.255-.57-.39-1.2-.39-1.846 0-2.58 2.1-4.65 4.65-4.65 1.53 0 2.85.705 3.72 1.8',
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
    icon: EXA,
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
    icon: APIFY,
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
  app('design', 'canva', 'Canva', 'Find, create and export designs', CANVA),
  app('design', 'miro', 'Miro', 'Read and add to boards', siMiro),
  // Communication
  app('communication', 'slack', 'Slack', 'Read channels and threads, and post messages', SLACK),
  app('communication', 'gmail', 'Gmail', 'Search, read and draft email', siGmail),
  app('communication', 'outlook', 'Outlook', 'Mail, calendar and contacts', OUTLOOK),
  app('communication', 'microsoft_teams', 'Microsoft Teams', 'Chats, channels and meetings', MICROSOFT_TEAMS),
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
  app('customers', 'salesforce', 'Salesforce', 'Accounts, contacts and opportunities', SALESFORCE),
  app('customers', 'intercom', 'Intercom', 'Conversations, contacts and help articles', siIntercom),
  app('customers', 'zendesk', 'Zendesk', 'Tickets, users and help center articles', siZendesk),
]

/** The key connector saved under this server name, if any. */
export const connectorById = (id: string) => CONNECTORS.find((c): c is KeyConnector => !c.toolkit && c.id === id)
