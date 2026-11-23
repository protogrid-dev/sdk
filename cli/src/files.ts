/**
 * Edits of the clients' config files: one server entry in or out, everything else kept as it was. A file that is not
 * plain JSON (VS Code allows comments) is refused rather than rewritten. Every write keeps the previous file as
 * `<file>.bak` and replaces the file in one rename.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class ConfigError extends Error {}

export function readJsonConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not plain JSON (comments or trailing commas?), so it is left untouched; add the entry by hand`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ConfigError(`${path} does not hold a JSON object; left untouched`);
  return doc as Record<string, unknown>;
}

/** The servers object under `rootKey`, refusing a file where it is something else. */
function servers(doc: Record<string, unknown>, rootKey: string, path: string): Record<string, unknown> {
  const s = doc[rootKey];
  if (s === undefined) return {};
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new ConfigError(`"${rootKey}" in ${path} is not an object; left untouched`);
  return s as Record<string, unknown>;
}

export function hasJsonEntry(doc: Record<string, unknown> | null, rootKey: string, key: string, path: string): boolean {
  return !!doc && Object.hasOwn(servers(doc, rootKey, path), key);
}

export function withJsonEntry(doc: Record<string, unknown> | null, rootKey: string, key: string, entry: unknown, path: string, newFile: Record<string, unknown> = {}): Record<string, unknown> {
  const base = doc ?? { ...newFile };
  return { ...base, [rootKey]: { ...servers(base, rootKey, path), [key]: entry } };
}

export function withoutJsonEntry(doc: Record<string, unknown>, rootKey: string, key: string, path: string): Record<string, unknown> {
  const rest = { ...servers(doc, rootKey, path) };
  delete rest[key];
  return { ...doc, [rootKey]: rest };
}

// ---------- Codex TOML ----------

const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** The header lines of `[mcp_servers.<key>]` and its subtables (`[mcp_servers.<key>.env]`), bare or quoted. */
function ownsHeader(line: string, key: string): boolean {
  const m = /^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/.exec(line);
  if (!m) return false;
  const name = m[1]!.startsWith('"') ? (JSON.parse(m[1]!) as string) : m[1]!;
  return name === key;
}

const isHeader = (line: string) => /^\s*\[/.test(line);

export function hasTomlServer(text: string, key: string): boolean {
  return text.split("\n").some((l) => ownsHeader(l, key));
}

/** `text` without the server's tables: from each of its headers to the next header of anything else. */
export function withoutTomlServer(text: string, key: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (isHeader(line)) skipping = ownsHeader(line, key);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** `text` with the server's tables replaced by `block` (the API's `codex-toml` text), appended at the end. */
export function withTomlServer(text: string, key: string, block: string): string {
  const kept = withoutTomlServer(text, key).replace(/\s+$/, "");
  return `${kept ? `${kept}\n\n` : ""}${block.replace(/\s+$/, "")}\n`;
}

export { tomlKey };

// ---------- writing ----------

/** Replaces `path` with `content`, keeping the previous file as `<path>.bak`; a file holding secrets is made private. */
export function writeConfig(path: string, content: string, opts: { secret: boolean }): { backup: string | null } {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  const existed = existsSync(path);
  if (existed) {
    backup = `${path}.bak`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.protogridctl-${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: existed ? statSync(path).mode & 0o777 : opts.secret ? 0o600 : 0o644 });
  if (opts.secret && process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if (backup && opts.secret && process.platform !== "win32") chmodSync(backup, 0o600);
  return { backup };
}

export const jsonText = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
