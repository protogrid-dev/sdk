/**
 * protogrid's tool-set hash, computed on the tools a server lists right now, to compare with the set protogrid checked
 * (the gate's `tools_hash`).
 *
 * The same canonical form as the registry: per tool, JSON with sorted keys of its name, title, description, input
 * schema, output schema and annotations (absent ones as null, a missing description as an empty string), SHA-256
 * truncated to 32 hex characters; the set hash is the same digest over the sorted `name NUL hash` lines.
 */
import { createHash } from "node:crypto";

export interface HashableTool {
  name: string;
  title?: string | null | undefined;
  description?: string | null | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** The hash of one tool definition. */
export function toolHash(t: HashableTool): string {
  return sha(
    stable({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
    }),
  );
}

/** The hash of a tool set, order-free; null for no tools. A repeated name counts once, its first definition. */
export function toolSetHash(tools: readonly HashableTool[]): string | null {
  const seen = new Map<string, string>();
  for (const t of tools) if (typeof t.name === "string" && t.name && !seen.has(t.name)) seen.set(t.name, toolHash(t));
  if (seen.size === 0) return null;
  return sha(
    [...seen]
      .map(([n, h]) => `${n}\u0000${h}`)
      .sort()
      .join("\n"),
  );
}
