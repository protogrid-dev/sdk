/**
 * Wire types of the protogrid REST API / MCP server. Hand-written to match the platform's
 * descriptor contract (see the descriptor docs); the SDK carries no server-specific knowledge.
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
  /** Quality score 0-100 (null when too few checks apply). */
  quality_score?: number | null;
  /** Plain-language label: strong, good, needs work, poor, new, not scored. Describes observed signals; not an audit. */
  quality_label?: "strong" | "good" | "needs work" | "poor" | "new" | "not scored" | "blocked";
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
  /** Someone proved control of the namespace (GitHub login or DNS TXT); says how and since when, never who. Not an audit. */
  owner?: { verified: boolean; method: "github" | "dns" | null; since: string | null };
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

/** On-demand checks (`POST /v1/check`): one credential-free probe of a remote MCP server URL. */
export type CheckStatus = "queued" | "running" | "done" | "failed";
export type ReadinessStatus = "pass" | "warn" | "fail" | "na" | "unknown" | "manual";

export interface ReadinessItem {
  id: string;
  directory: "claude" | "openai";
  title: string;
  level: "must" | "should";
  /** `heuristic` items only ask for a review; `manual` ones nobody can see from outside. */
  kind: "auto" | "heuristic" | "manual";
  /** The directory documentation page the requirement comes from. */
  source: string;
  status: ReadinessStatus;
  detail: string;
}

export interface DirectoryReadiness {
  directory: "claude" | "openai";
  name: string;
  checked_on: string;
  docs: string;
  items: ReadinessItem[];
  summary: { blockers: number; warnings: number; review: number; unknown: number; manual: number };
}

export interface QualityCheck {
  id: string;
  category: "protocol" | "auth" | "hygiene" | "stability";
  status: "pass" | "warn" | "fail" | "na";
  detail: string;
}

export interface CheckResult {
  checked_at: string;
  url: string;
  /** Catalog server whose remote has this URL. */
  server: string | null;
  probe: {
    outcome: "ok" | "auth_required" | "unreachable" | "timeout" | "protocol_error" | "blocked";
    http_status: number | null;
    duration_ms: number;
    latency_ms: number | null;
    protocol: { era: "modern" | "legacy" | "legacy-sse" | null; versions: string[]; stateless: boolean | null };
    list_ttl_ms: number | null;
    auth: {
      type: AuthType;
      www_authenticate: string | null;
      resource_metadata_url: string | null;
      resource: string | null;
      authorization_servers: string[];
      authorization_server_metadata_url: string | null;
      issuer: string | null;
      scopes: string[];
      code_challenge_methods: string[];
      grant_types: string[];
      token_endpoint_auth_methods: string[];
      cimd_supported: boolean;
      dcr_supported: boolean;
    };
    server_info: { name: string | null; version: string | null };
    instructions: string | null;
    tools: { name: string; title: string | null; description: string | null; annotations: Record<string, boolean | string> | null }[] | null;
    tools_truncated: boolean;
    tools_omitted: number;
    redirects: { from: string; to: string; status: number }[];
    dns: { ipv4: boolean; ipv6: boolean } | null;
    error: string | null;
  };
  quality: {
    score: number | null;
    /** good, needs work, poor or not scored: one probe has no history and no trust score. */
    label: string;
    components: Record<string, number | null>;
    checks: QualityCheck[];
    drivers: string[];
    tool_count: number;
    token_estimate: number | null;
  };
  readiness: DirectoryReadiness[];
}

export interface CheckResponse {
  id: string;
  status: CheckStatus;
  url: string;
  requested_at: string;
  finished_at: string | null;
  server: string | null;
  /** Shareable result page on the portal. */
  page: string;
  /** Present once `status` is `done`. */
  result?: CheckResult;
  error?: string;
  disclaimer: string;
  next_actions: NextAction[];
}
