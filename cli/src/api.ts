/** The few protogrid API calls protogridctl makes; public data, no account needed (an API key only raises limits). */

export const DEFAULT_API = "https://api.protogrid.dev";

export interface Connection {
  server: string;
  key: string;
  kind: "remote" | "package" | "bundle";
  class: string;
  content_type: "application/json" | "text/plain";
  connection: unknown;
  secrets: { name: string; where: string }[];
  auth_type?: string;
  human_steps?: string[];
}

export interface Gate {
  server: string;
  pass: boolean;
  failed: { rule: string; detail: string }[];
  quality: { score: number | null; label: string; flags: string[] };
  trust: { score: number | null; flags: string[] };
  class: string;
  owner_verified: boolean;
  /** Charges per call: listed with prices in an x402 Bazaar, or declared by the server. */
  payment?: "listed" | "declared" | null;
}

export interface SearchResult {
  name: string;
  title?: string | null;
  description?: string | null;
  connection_class?: string;
  quality_score?: number | null;
  quality_flags?: string[];
  owner_verified?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export interface Api {
  gate(name: string, rules: Record<string, string>): Promise<Gate>;
  connection(name: string, target: string): Promise<Connection>;
  search(q: string, limit: number): Promise<SearchResult[]>;
}

export function createApi(opts: { baseUrl?: string | undefined; apiKey?: string | undefined; fetch?: typeof fetch; version: string }): Api {
  const base = (opts.baseUrl ?? DEFAULT_API).replace(/\/+$/, "");
  const f = opts.fetch ?? fetch;
  const get = async <T>(path: string): Promise<T> => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `protogridctl/${opts.version}` };
    if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
    const res = await f(`${base}${path}`, { headers });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ApiError(res.status, typeof body?.["error"] === "string" ? body["error"] : null, typeof body?.["message"] === "string" ? body["message"] : `HTTP ${res.status}`);
    return body as T;
  };
  const enc = encodeURIComponent;
  return {
    gate: (name, rules) => get<Gate>(`/v1/servers/${enc(name)}/gate?${new URLSearchParams(rules)}`),
    connection: (name, target) => get<Connection>(`/v1/servers/${enc(name)}/connection?target=${enc(target)}`),
    search: async (q, limit) => (await get<{ results: SearchResult[] }>(`/v1/search?${new URLSearchParams({ q, limit: String(limit) })}`)).results,
  };
}
