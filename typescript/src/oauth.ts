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
import type { OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";

// ---------- token store ----------

/**
 * Minimal async key/value store; keys are `${serverName}:${kind}`. Bring your own (KMS, DB, …).
 * Return values exactly as they were set: stored tokens carry the issuer that granted them, and the
 * MCP SDK refuses to use them with another authorization server.
 */
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

/**
 * One JSON file, mode 0600, refresh tokens in plain text. Fine for a single agent process on a machine
 * you control; use an encrypted store (OS keychain, KMS) anywhere else.
 */
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

/** How the one-time consent happens: show the URL, then hand back the redirect's parameters. */
export interface ConsentHandler {
  /** Redirect URI registered with the authorization server (loopback by default). */
  redirectUrl: string;
  /** Called with the authorization URL the human must open. */
  onAuthorizationUrl(url: URL): void | Promise<void>;
  /**
   * Resolves with the query parameters of the redirect, all of them (`code`, `state`, `iss`, or
   * `error`): `connectClient` checks `state` and the MCP SDK checks `iss` before the code is exchanged.
   */
  waitForCallback(opts?: { timeoutMs?: number }): Promise<URLSearchParams>;
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
  let resolveCallback: ((params: URLSearchParams) => void) | null = null;
  const pending = new Promise<URLSearchParams>((res) => {
    resolveCallback = res;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(opts.successHtml ?? "<!doctype html><title>Authorized</title><p>Authorization received. You can close this tab.</p>");
    resolveCallback?.(url.searchParams);
  });
  await new Promise<void>((res) => server.listen(opts.port ?? 0, host, res));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    redirectUrl: `http://${host}:${port}${path}`,
    onAuthorizationUrl: opts.onAuthorizationUrl ?? ((url) => console.error(`Open this URL to authorize:\n${url}`)),
    waitForCallback: ({ timeoutMs = 5 * 60_000 } = {}) => {
      const t = new Promise<URLSearchParams>((_, rej) => setTimeout(() => rej(new Error("timed out waiting for the authorization redirect")), timeoutMs).unref());
      return Promise.race([pending, t]);
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/**
 * For headless agents: the host relays the authorization URL to a human (a chat, a queue) and hands
 * back the full URL the browser was redirected to, from which `code`, `state` and `iss` are read.
 */
export function manualConsent(opts: { redirectUrl: string; onAuthorizationUrl: (url: URL) => void | Promise<void>; waitForRedirect: () => Promise<string> }): ConsentHandler {
  return {
    redirectUrl: opts.redirectUrl,
    onAuthorizationUrl: opts.onAuthorizationUrl,
    waitForCallback: async () => {
      const raw = (await opts.waitForRedirect()).trim();
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("manualConsent: waitForRedirect must return the full URL the browser was redirected to");
      }
      return url.searchParams;
    },
  };
}

/**
 * Checks the redirect of a consent before its code is used: the `state` must be the one this flow
 * stored for `serverName` (it is used once), and an `error` stops the flow. Only the error code is
 * repeated, never `error_description`: before the issuer check, those values may come from an attacker.
 */
export async function verifyCallback(store: TokenStore, serverName: string, params: URLSearchParams): Promise<void> {
  const expected = (await store.get(`${serverName}:state`)) as string | undefined;
  await store.delete(`${serverName}:state`);
  const state = params.get("state");
  if (!expected || !state || state !== expected) throw new Error("authorization redirect refused: its state does not match this flow");
  const error = params.get("error");
  if (error != null) {
    const code = /^[a-z_]{1,64}$/.test(error) ? error : "unknown";
    throw new Error(`authorization was not granted (${code})`);
  }
  if (!params.get("code")) throw new Error("authorization redirect has no code");
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
      return (await store.get(k("client"))) as StoredOAuthClientInformation | undefined;
    },
    async saveClientInformation(info) {
      await store.set(k("client"), info);
    },
    async tokens() {
      return (await store.get(k("tokens"))) as StoredOAuthTokens | undefined;
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
    // Which authorization server the redirect targeted, so the code is exchanged at the same one.
    async saveDiscoveryState(state) {
      await store.set(k("discovery"), state);
    },
    async discoveryState() {
      return (await store.get(k("discovery"))) as OAuthDiscoveryState | undefined;
    },
    async invalidateCredentials(scope) {
      const kinds = scope === "all" ? ["client", "tokens", "verifier", "state", "discovery"] : [scope];
      for (const kind of kinds) await store.delete(k(kind));
    },
  };
  if (opts.clientMetadataUrl) provider.clientMetadataUrl = opts.clientMetadataUrl;
  return provider;
}
