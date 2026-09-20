import type {
  ConnectionClass,
  ConnectionResponse,
  ConnectionTarget,
  Descriptor,
  ErrorBody,
  ListToolsResponse,
  McpServersConnection,
  SearchResponse,
  TrustFlag,
} from "./types.js";

/** The public registry. Point `baseUrl` at `http://localhost:8080` for a self-hosted or local stack. */
export const DEFAULT_BASE_URL = "https://api.protogrid.dev";

export interface ClientOptions {
  /** Base URL of the registry API (default: the public registry). */
  baseUrl?: string | undefined;
  /** Optional API key for higher limits (slice 6); sent as `Authorization: Bearer`. */
  apiKey?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** Request timeout in ms (default 15000). */
  timeoutMs?: number | undefined;
  userAgent?: string | undefined;
}

export interface SearchParams {
  q: string;
  limit?: number;
  /** Connection classes to keep, e.g. `["R0", "R1"]` for what an agent can reach on its own. */
  class?: ConnectionClass[];
  transport?: "streamable-http" | "sse";
  category?: string;
  min_trust?: number;
  /** Every listed flag must be present. */
  flags?: TrustFlag[];
  /** Any listed flag excludes a server, e.g. `["multi-version-spam", "duplicate-repo"]`. */
  exclude_flags?: TrustFlag[];
}

export class ProtogridError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ErrorBody | null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
    this.name = "ProtogridError";
  }
  get code(): string {
    return this.body?.error ?? `http_${this.status}`;
  }
}

export class ProtogridClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: ClientOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("no fetch available; pass one in ClientOptions.fetch");
  }

  search(params: SearchParams): Promise<SearchResponse> {
    const q = new URLSearchParams({ q: params.q });
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.class?.length) q.set("class", params.class.join(","));
    if (params.transport) q.set("transport", params.transport);
    if (params.category) q.set("category", params.category);
    if (params.min_trust != null) q.set("min_trust", String(params.min_trust));
    if (params.flags?.length) q.set("flags", params.flags.join(","));
    if (params.exclude_flags?.length) q.set("exclude_flags", params.exclude_flags.join(","));
    return this.get(`/v1/search?${q}`);
  }

  getServer(name: string, opts: { schemas?: boolean } = {}): Promise<Descriptor> {
    return this.get(`/v1/servers/${encodeURIComponent(name)}${opts.schemas ? "?schemas=true" : ""}`);
  }

  listTools(name: string, opts: { limit?: number; cursor?: string } = {}): Promise<ListToolsResponse> {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.get(`/v1/servers/${encodeURIComponent(name)}/tools${qs ? `?${qs}` : ""}`);
  }

  /** Every current tool, following `next_cursor` to the end. */
  async listAllTools(name: string): Promise<ListToolsResponse["tools"]> {
    const out: ListToolsResponse["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listTools(name, { limit: 100, ...(cursor ? { cursor } : {}) });
      out.push(...page.tools);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  getConnection(name: string): Promise<McpServersConnection>;
  getConnection(name: string, target: "mcpServers"): Promise<McpServersConnection>;
  getConnection(name: string, target: ConnectionTarget): Promise<ConnectionResponse>;
  getConnection(name: string, target: ConnectionTarget = "mcpServers"): Promise<ConnectionResponse> {
    return this.get(`/v1/servers/${encodeURIComponent(name)}/connection?target=${encodeURIComponent(target)}`);
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      if (this.opts.userAgent) headers["user-agent"] = this.opts.userAgent;
      const res = await this.fetchImpl(`${this.base}${path}`, { headers, signal: controller.signal });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!res.ok) {
        const ra = res.headers.get("retry-after");
        throw new ProtogridError(res.status, (body as ErrorBody | null) ?? { error: `http_${res.status}`, message: text.slice(0, 200) }, ra ? Number(ra) * 1000 : null);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createClient(opts: ClientOptions = {}): ProtogridClient {
  return new ProtogridClient(opts);
}
