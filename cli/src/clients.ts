/**
 * The MCP clients protogridctl can configure: where each keeps its servers, under which key, and which connection
 * target of the protogrid API gives the entry in its own shape.
 */
import { join } from "node:path";

export type Scope = "user" | "project";

/** Where the person's files are; injected so tests never touch the real home directory. */
export interface Env {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  /** `%APPDATA%` on Windows. */
  appData?: string | undefined;
  /** `$XDG_CONFIG_HOME`, defaulting to `~/.config`. */
  xdgConfig?: string | undefined;
  /** `$CODEX_HOME`, defaulting to `~/.codex`. */
  codexHome?: string | undefined;
}

export type Format =
  /** A JSON file with the servers under `rootKey`. */
  | "json"
  /** Codex's `config.toml`, one `[mcp_servers.<key>]` table per server. */
  | "toml"
  /** The client's own command adds it (`claude mcp add-json`). */
  | "command"
  /** Shown for the person to paste: no writer yet. */
  | "print";

export interface Location {
  format: Format;
  /** The file, for `json`, `toml` and `print`. */
  path?: string;
  rootKey?: string;
  /** Keys a new file starts with, such as opencode's `$schema`. */
  newFile?: Record<string, unknown>;
}

export interface ClientSpec {
  id: string;
  label: string;
  /** The `target` of `GET /v1/servers/{name}/connection`. */
  target: "mcpServers" | "vscode" | "cursor" | "codex-toml" | "opencode" | "gemini" | "goose";
  /** Where it goes for each scope, or null when the client has no such scope. */
  locate(env: Env, scope: Scope): Location | null;
  /** Claude Desktop reads only local servers from its file; remote ones are added as connectors in the app. */
  localOnly?: boolean;
}

const config = (env: Env) => env.xdgConfig ?? join(env.home, ".config");
/** VS Code's and Claude Desktop's per-user folder on each platform. */
const appDir = (env: Env, app: string) =>
  env.platform === "darwin" ? join(env.home, "Library", "Application Support", app) : env.platform === "win32" ? join(env.appData ?? join(env.home, "AppData", "Roaming"), app) : join(config(env), app);

export const CLIENTS: ClientSpec[] = [
  {
    id: "cursor",
    label: "Cursor",
    target: "cursor",
    locate: (env, scope) => ({ format: "json", path: scope === "user" ? join(env.home, ".cursor", "mcp.json") : join(env.cwd, ".cursor", "mcp.json"), rootKey: "mcpServers" }),
  },
  {
    id: "vscode",
    label: "VS Code",
    target: "vscode",
    locate: (env, scope) => ({ format: "json", path: scope === "user" ? join(appDir(env, "Code"), "User", "mcp.json") : join(env.cwd, ".vscode", "mcp.json"), rootKey: "servers" }),
  },
  {
    id: "claude-code",
    label: "Claude Code",
    target: "mcpServers",
    locate: (env, scope) => (scope === "user" ? { format: "command" } : { format: "json", path: join(env.cwd, ".mcp.json"), rootKey: "mcpServers" }),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    target: "mcpServers",
    localOnly: true,
    locate: (env, scope) => (scope === "user" ? { format: "json", path: join(appDir(env, "Claude"), "claude_desktop_config.json"), rootKey: "mcpServers" } : null),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    target: "gemini",
    locate: (env, scope) => ({ format: "json", path: scope === "user" ? join(env.home, ".gemini", "settings.json") : join(env.cwd, ".gemini", "settings.json"), rootKey: "mcpServers" }),
  },
  {
    id: "codex",
    label: "Codex",
    target: "codex-toml",
    locate: (env, scope) => (scope === "user" ? { format: "toml", path: join(env.codexHome ?? join(env.home, ".codex"), "config.toml") } : null),
  },
  {
    id: "opencode",
    label: "opencode",
    target: "opencode",
    locate: (env, scope) => ({ format: "json", path: scope === "user" ? join(config(env), "opencode", "opencode.json") : join(env.cwd, "opencode.json"), rootKey: "mcp", newFile: { $schema: "https://opencode.ai/config.json" } }),
  },
  {
    id: "goose",
    label: "Goose",
    target: "goose",
    locate: (env, scope) => (scope === "user" ? { format: "print", path: join(config(env), "goose", "config.yaml") } : null),
  },
];

export function findClient(id: string): ClientSpec | undefined {
  return CLIENTS.find((c) => c.id === id);
}

export function envFromProcess(): Env {
  const e = process.env;
  return { home: e["HOME"] ?? e["USERPROFILE"] ?? process.cwd(), cwd: process.cwd(), platform: process.platform, appData: e["APPDATA"], xdgConfig: e["XDG_CONFIG_HOME"] || undefined, codexHome: e["CODEX_HOME"] || undefined };
}
