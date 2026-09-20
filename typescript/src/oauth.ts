/**
 * OAuth for R2 servers (D4: the agent holds the tokens, the registry only exposes metadata).
 * The official MCP SDK already runs the whole client flow (protected-resource + authorization-
 * server metadata, dynamic registration or Client ID Metadata Documents, PKCE, refresh) behind
 * its `OAuthClientProvider` interface. This module supplies that provider with a pluggable
 * token store and the single human step: the one-time consent.
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// ---------- token store ----------

/** Minimal async key/value store; keys are `${serverName}:${kind}`. Bring your own (KMS, DB, …). */
export interface TokenStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private readonly m = new Map<string, unknown>();
  async get(key: string) {
    return this.m.get(key);
  }
  async set(key: string, value: unknown) {
    this.m.set(key, value);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
}

/** One JSON file, mode 0600. Fine for a single agent process; not for shared hosts. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}
  private async read(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fs.readFile(this.path, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  private async write(data: Record<string, unknown>) {
    await fs.writeFile(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  async get(key: string) {
    return (await this.read())[key];
  }
  async set(key: string, value: unknown) {
    const d = await this.read();
    d[key] = value;
    await this.write(d);
  }
  async delete(key: string) {
    const d = await this.read();
    delete d[key];
    await this.write(d);
  }
}

/** True when the store already holds tokens for `serverName` (so an R2 server needs no human now). */
export async function hasTokens(store: TokenStore, serverName: string): Promise<boolean> {
  return (await store.get(`${serverName}:tokens`)) != null;
}

// ---------- consent ----------

/** How the one-time consent happens: show the URL, then hand back the authorization code. */
export interface ConsentHandler {
  /** Redirect URI registered with the authorization server (loopback by default). */
  redirectUrl: string;
  /** Called with the authorization URL the human must open. */
  onAuthorizationUrl(url: URL): void | Promise<void>;
  /** Resolves with the `code` from the redirect. */
  waitForCode(opts?: { timeoutMs?: number }): Promise<string>;
  close?(): void | Promise<void>;
}

export interface LoopbackOptions {
  host?: string;
  /** 0 picks a free port. Fixed ports are easier to pre-register with servers that need it. */
  port?: number;
  path?: string;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  /** HTML shown to the human after the redirect. */
  successHtml?: string;
}

/**
 * Loopback redirect receiver (RFC 8252 §7.3): a tiny local HTTP server that catches the
 * redirect and extracts `code`. Default `onAuthorizationUrl` prints the URL to stderr.
 */
export async function loopbackConsent(opts: LoopbackOptions = {}): Promise<ConsentHandler> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/callback";
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  const pending = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(opts.successHtml ?? "<!doctype html><title>Authorized</title><p>Authorization received. You can close this tab.</p>");
    if (code) resolveCode?.(code);
    else rejectCode?.(new Error(`authorization failed: ${error ?? "no code in redirect"} ${url.searchParams.get("error_description") ?? ""}`.trim()));
  });
  await new Promise<void>((res) => server.listen(opts.port ?? 0, host, res));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    redirectUrl: `http://${host}:${port}${path}`,
    onAuthorizationUrl: opts.onAuthorizationUrl ?? ((url) => console.error(`Open this URL to authorize:\n${url}`)),
    waitForCode: ({ timeoutMs = 5 * 60_000 } = {}) => {
      const t = new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timed out waiting for the authorization redirect")), timeoutMs).unref());
      return Promise.race([pending, t]);
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/** For headless agents: the host relays the URL and the code (e.g. via a chat or a queue). */
export function manualConsent(opts: { redirectUrl: string; onAuthorizationUrl: (url: URL) => void | Promise<void>; waitForCode: () => Promise<string> }): ConsentHandler {
  return { ...opts };
}

// ---------- provider ----------

export interface OAuthOptions {
  store: TokenStore;
  consent: ConsentHandler;
  /** Shown on the consent screen. */
  clientName?: string;
  /** Client ID Metadata Document URL (2025-11-25+). Used when the server advertises support; else dynamic registration. */
  clientMetadataUrl?: string;
  scope?: string;
}

/** `OAuthClientProvider` backed by a `TokenStore`, scoped to one server name. */
export function createOAuthProvider(serverName: string, opts: OAuthOptions): OAuthClientProvider {
  const k = (kind: string) => `${serverName}:${kind}`;
  const { store } = opts;
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return opts.consent.redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: opts.clientName ?? "protogrid-sdk agent",
        redirect_uris: [opts.consent.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(opts.scope ? { scope: opts.scope } : {}),
      };
    },
    async state() {
      const s = randomBytes(16).toString("hex");
      await store.set(k("state"), s);
      return s;
    },
    async clientInformation() {
      return (await store.get(k("client"))) as OAuthClientInformationMixed | undefined;
    },
    async saveClientInformation(info) {
      await store.set(k("client"), info);
    },
    async tokens() {
      return (await store.get(k("tokens"))) as OAuthTokens | undefined;
    },
    async saveTokens(tokens) {
      await store.set(k("tokens"), tokens);
    },
    async redirectToAuthorization(url) {
      await opts.consent.onAuthorizationUrl(url);
    },
    async saveCodeVerifier(v) {
      await store.set(k("verifier"), v);
    },
    async codeVerifier() {
      const v = (await store.get(k("verifier"))) as string | undefined;
      if (!v) throw new Error("no PKCE code verifier saved; start the authorization again");
      return v;
    },
    async invalidateCredentials(scope) {
      const kinds = scope === "all" ? ["client", "tokens", "verifier", "state"] : scope === "client" ? ["client"] : scope === "tokens" ? ["tokens"] : scope === "verifier" ? ["verifier"] : [];
      for (const kind of kinds) await store.delete(k(kind));
    },
  };
  if (opts.clientMetadataUrl) provider.clientMetadataUrl = opts.clientMetadataUrl;
  return provider;
}
