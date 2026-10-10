import type {
  ChangesResponse,
  CheckResponse,
  ConnectionClass,
  ConnectionResponse,
  ConnectionTarget,
  DependenciesResponse,
  Descriptor,
  ErrorBody,
  ListToolsResponse,
  McpServersConnection,
  QualityFlag,
  QualityResponse,
  SearchResponse,
  TrustFlag,
} from "./types.js";

/** The public registry. Point `baseUrl` at `http://localhost:8080` for a self-hosted or local stack. */
export const DEFAULT_BASE_URL = "https://api.protogrid.dev";
/** Longest the registry holds a check request open. */
export const MAX_CHECK_WAIT_S = 25;

export interface ClientOptions {
  /** Base URL of the registry API (default: the public registry). */
  baseUrl?: string | undefined;
  /**
   * Optional API key for higher limits; sent as `Authorization: Bearer`. Defaults to the
   * `PROTOGRID_API_KEY` environment variable when running under Node; pass `""` to send none.
   * Create one at https://protogrid.dev/account.
   */
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
  /** Minimum quality score 0-100; servers that are not scored are left out. */
  min_quality?: number;
  /** Every listed quality flag must be present. */
  quality_flags?: QualityFlag[];
  /** Any listed quality flag excludes a server, e.g. `["known-vulns"]`. */
  exclude_quality_flags?: QualityFlag[];
  /** `true` keeps only servers whose owner proved control of the namespace (not an audit). */
  owner_verified?: boolean;
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

/**
 * A rejected promise when an argument is missing, empty or not a string (untyped callers passed objects such as
 * `getServer({ name })`, which reached the API as `[object Object]`); undefined when every argument is fine.
 */
function refuse(method: string, args: Record<string, unknown>): Promise<never> | undefined {
  for (const [arg, value] of Object.entries(args)) {
    if (typeof value !== "string" || value.trim() === "") {
      const got = value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? "an empty string" : typeof value;
      return Promise.reject(new TypeError(`${method} needs ${arg} as a non-empty string, got ${got}`));
    }
  }
  return undefined;
}

export class ProtogridClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;
  constructor(private readonly opts: ClientOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PROTOGRID_API_KEY;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("no fetch available; pass one in ClientOptions.fetch");
  }

  /** `search("text")` is shorthand for `search({ q: "text" })`. A missing or empty query rejects with a `TypeError`. */
  search(params: SearchParams | string): Promise<SearchResponse> {
    if (typeof params === "string") params = { q: params };
    if (typeof params?.q !== "string" || params.q.trim() === "") {
      return Promise.reject(new TypeError('search needs a query: search("send an email") or search({ q: "send an email", ... })'));
    }
    const q = new URLSearchParams({ q: params.q });
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.class?.length) q.set("class", params.class.join(","));
    if (params.transport) q.set("transport", params.transport);
    if (params.category) q.set("category", params.category);
    if (params.min_trust != null) q.set("min_trust", String(params.min_trust));
    if (params.flags?.length) q.set("flags", params.flags.join(","));
    if (params.exclude_flags?.length) q.set("exclude_flags", params.exclude_flags.join(","));
    if (params.min_quality != null) q.set("min_quality", String(params.min_quality));
    if (params.quality_flags?.length) q.set("quality_flags", params.quality_flags.join(","));
    if (params.exclude_quality_flags?.length) q.set("exclude_quality_flags", params.exclude_quality_flags.join(","));
    if (params.owner_verified != null) q.set("owner_verified", String(params.owner_verified));
    return this.get(`/v1/search?${q}`);
  }

  getServer(name: string, opts: { schemas?: boolean } = {}): Promise<Descriptor> {
    const bad = refuse("getServer", { name });
    if (bad) return bad;
    return this.get(`/v1/servers/${encodeURIComponent(name)}${opts.schemas ? "?schemas=true" : ""}`);
  }

  listTools(name: string, opts: { limit?: number; cursor?: string } = {}): Promise<ListToolsResponse> {
    const bad = refuse("listTools", { name });
    if (bad) return bad;
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.get(`/v1/servers/${encodeURIComponent(name)}/tools${qs ? `?${qs}` : ""}`);
  }

  /** Every current tool, following `next_cursor` to the end. */
  async listAllTools(name: string): Promise<ListToolsResponse["tools"]> {
    const bad = refuse("listAllTools", { name });
    if (bad) return bad;
    const out: ListToolsResponse["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listTools(name, { limit: 100, ...(cursor ? { cursor } : {}) });
      out.push(...page.tools);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  /** The quality block, the verified owner and the daily score for the last `days` (default 90, up to 400). */
  getQuality(name: string, opts: { days?: number } = {}): Promise<QualityResponse> {
    const bad = refuse("getQuality", { name });
    if (bad) return bad;
    return this.get(`/v1/servers/${encodeURIComponent(name)}/quality${opts.days != null ? `?days=${opts.days}` : ""}`);
  }

  /** Tool-definition history, newest first; pass `next_before` back as `before` for the next page. */
  getChanges(name: string, opts: { limit?: number; before?: number } = {}): Promise<ChangesResponse> {
    const bad = refuse("getChanges", { name });
    if (bad) return bad;
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.before != null) q.set("before", String(opts.before));
    const qs = q.toString();
    return this.get(`/v1/servers/${encodeURIComponent(name)}/changes${qs ? `?${qs}` : ""}`);
  }

  /** npm and PyPI packages of the server with their resolved dependency graphs and known advisories. */
  getDependencies(name: string): Promise<DependenciesResponse> {
    const bad = refuse("getDependencies", { name });
    if (bad) return bad;
    return this.get(`/v1/servers/${encodeURIComponent(name)}/dependencies`);
  }

  getConnection(name: string): Promise<McpServersConnection>;
  getConnection(name: string, target: "mcpServers"): Promise<McpServersConnection>;
  getConnection(name: string, target: ConnectionTarget): Promise<ConnectionResponse>;
  getConnection(name: string, target: ConnectionTarget = "mcpServers"): Promise<ConnectionResponse> {
    const bad = refuse("getConnection", { name, target });
    if (bad) return bad;
    return this.get(`/v1/servers/${encodeURIComponent(name)}/connection?target=${encodeURIComponent(target)}`);
  }

  /**
   * Checks a remote MCP server URL, listed or not: one credential-free probe (no tool is called),
   * the quality checks and the readiness for the Claude and OpenAI directories. Waits for the result
   * up to `waitMs` (default 90 s; 0 returns at once) and returns the check as it stands then, so a
   * `queued` or `running` answer can be read later with `getCheck(id)`. The same URL within a few
   * minutes returns the recent check, unless `fresh` is set with an API key (for CI right after a deploy;
   * it counts against the hourly allowance, and anonymous calls ignore it). A refused URL throws
   * `invalid_url`; an exhausted hourly allowance throws `check_quota_exceeded` with `retryAfterMs`.
   */
  async check(url: string, opts: { waitMs?: number; fresh?: boolean } = {}): Promise<CheckResponse> {
    const bad = refuse("check", { url });
    if (bad) return bad;
    const deadline = Date.now() + (opts.waitMs ?? 90_000);
    const waitS = () => Math.max(0, Math.min(MAX_CHECK_WAIT_S, Math.floor((deadline - Date.now()) / 1000)));
    let c = await this.request<CheckResponse>("POST", `/v1/check?wait=${waitS()}`, opts.fresh ? { url, fresh: true } : { url }, waitS());
    while ((c.status === "queued" || c.status === "running") && waitS() > 0) c = await this.getCheck(c.id, { waitS: waitS() });
    return c;
  }

  /** Reads a check; `waitS` (up to 25) holds the request until it finishes. Results are kept 30 days. */
  getCheck(id: string, opts: { waitS?: number } = {}): Promise<CheckResponse> {
    const bad = refuse("getCheck", { id });
    if (bad) return bad;
    const wait = Math.max(0, Math.min(MAX_CHECK_WAIT_S, opts.waitS ?? 0));
    return this.request("GET", `/v1/check/${encodeURIComponent(id)}${wait ? `?wait=${wait}` : ""}`, undefined, wait);
  }

  private get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  /** `waitS`: seconds the server may hold the request, added to the timeout. */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, waitS = 0): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (this.opts.timeoutMs ?? 15_000) + waitS * 1000);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      if (this.opts.userAgent) headers["user-agent"] = this.opts.userAgent;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, signal: controller.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        const ra = res.headers.get("retry-after");
        throw new ProtogridError(res.status, (parsed as ErrorBody | null) ?? { error: `http_${res.status}`, message: text.slice(0, 200) }, ra ? Number(ra) * 1000 : null);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createClient(opts: ClientOptions = {}): ProtogridClient {
  return new ProtogridClient(opts);
}
