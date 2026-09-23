/**
 * Wire types of the protogrid REST API / MCP server. Hand-written to match the platform's
 * descriptor contract (DESIGN §5/§7/§8); the SDK carries no server-specific knowledge.
 */

export type ConnectionClass = "R0" | "R1" | "R2" | "L0" | "unknown";
export type AuthType = "none" | "api_key" | "oauth2" | "unknown";
export type RemoteTransport = "streamable-http" | "sse";
export type ConnectionTarget = "mcpServers" | "vscode" | "cursor" | "claude-code-cli" | "codex-toml" | "opencode" | "gemini" | "goose";
export type TrustFlag = "multi-version-spam" | "duplicate-repo" | "no-repository" | "no-connection" | "deprecated" | "unreachable" | "blocked" | "deleted";

/** Reverse-DNS namespace of protogrid.dev under `_meta`. */
export const META_NS = "dev.protogrid";

export interface NextAction {
  action: "search" | "get_server" | "list_tools" | "get_connection";
  description: string;
  href: string;
  arguments?: Record<string, unknown>;
}

export interface SearchResult {
  name: string;
  title: string | null;
  description: string;
  connection_class: ConnectionClass;
  autonomous: boolean;
  human_steps: string[];
  categories: string[];
  trust_score: number | null;
  trust_flags: TrustFlag[];
  tool_count: number;
  score: number;
  matched_tools: { name: string; description: string }[];
}

export interface SearchResponse {
  query: string;
  mode: "hybrid" | "keyword";
  count: number;
  results: SearchResult[];
  next_actions: NextAction[];
}

export interface DescriptorHeader {
  name: string;
  required: boolean;
  secret: boolean;
  value: string | null;
  secret_names: string[];
}

export interface OAuthMetadata {
  resource_metadata_url: string | null;
  authorization_servers: string[];
  scopes: string[];
  cimd_supported: boolean;
  dcr_supported: boolean;
  grant_types: string[];
  code_challenge_methods: string[];
  authorization_server_metadata_url: string | null;
}

export interface DescriptorRemote {
  idx: number;
  url: string;
  transport: RemoteTransport;
  templated: boolean;
  headers: DescriptorHeader[];
  auth: { type: AuthType; location: { header: string; scheme?: string } | null; secret_name: string | null; oauth: OAuthMetadata | null };
  protocol: { supported_versions: string[]; stateless: boolean | null };
  health: { reachable: boolean | null; uptime_30d: number | null; latency_ms_p50: number | null; consecutive_failures: number; last_probe_at: string | null; last_ok_at: string | null };
}

export interface DescriptorPackage {
  idx: number;
  registry_type: string;
  identifier: string;
  version: string | null;
  runtime_hint: string | null;
  transport: string;
  secrets: string[];
  requires_execution: boolean;
}

export interface Connectability {
  class: ConnectionClass;
  autonomous: boolean;
  human_steps: string[];
  preferred: { kind: "remote" | "package"; idx: number } | null;
  remotes: DescriptorRemote[];
  packages: DescriptorPackage[];
}

export interface DescriptorTool {
  name: string;
  title: string | null;
  description: string;
  input_schema?: unknown;
  output_schema?: unknown;
  annotations: unknown;
  source: "probe" | "publisher";
  observed_at: string;
}

export interface Trust {
  score: number | null;
  components: { provenance: number; liveness: number | null; freshness: number; hygiene: number } | null;
  drivers: string[];
  flags: string[];
  blocked: boolean;
  computed_at: string | null;
  disclaimer: string;
}

export interface Identity {
  canonical_id: string;
  aliases: string[];
  alias_count: number;
  repository_key: string | null;
}

/** The official `server.json` object as published; typed loosely on purpose. */
export interface OfficialServer {
  name: string;
  description?: string;
  title?: string;
  version: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  packages?: Record<string, unknown>[];
  remotes?: Record<string, unknown>[];
  [k: string]: unknown;
}

export interface Descriptor {
  server: OfficialServer;
  _meta: {
    "io.modelcontextprotocol.registry/official": { status?: string; isLatest?: boolean; publishedAt?: string; updatedAt?: string } | null;
    [k: `${string}/connectability`]: Connectability;
    [k: `${string}/tools`]: DescriptorTool[];
    [k: `${string}/trust`]: Trust;
    [k: `${string}/identity`]: Identity;
  };
  next_actions: NextAction[];
}

export interface ListToolsResponse {
  server: string;
  count: number;
  tools: (DescriptorTool & { input_schema: unknown; output_schema: unknown })[];
  next_cursor: string | null;
  next_actions: NextAction[];
}

export interface SecretRef {
  name: string;
  where: string;
}

/** Generic `mcpServers` block for one server, as returned for `target=mcpServers`. */
export type McpServersEntry =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { command: string; args: string[]; env?: Record<string, string> };

export interface ConnectionResponse<T = unknown> {
  server: string;
  key: string;
  kind: "remote" | "package" | "bundle";
  class: ConnectionClass;
  autonomous: boolean;
  human_steps: string[];
  target: ConnectionTarget;
  content_type: "application/json" | "text/plain";
  connection: T;
  secrets: SecretRef[];
  auth_type?: AuthType;
  oauth?: OAuthMetadata;
  placeholders: string;
  next_actions: NextAction[];
}

export type McpServersConnection = ConnectionResponse<{ mcpServers: Record<string, McpServersEntry> }>;

export interface ErrorBody {
  error: string;
  message?: string;
  server?: string;
  next_actions?: NextAction[];
  [k: string]: unknown;
}
