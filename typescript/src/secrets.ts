/**
 * `${NAME}` placeholder substitution. The registry never sees secret values; the caller
 * supplies them here, at the last moment, from whatever store it already has.
 */

const PLACEHOLDER = /\$\{([A-Za-z0-9_.-]+)\}/g;

export class MissingSecretsError extends Error {
  constructor(public readonly missing: string[]) {
    super(`missing secrets: ${missing.join(", ")}`);
    this.name = "MissingSecretsError";
  }
}

/** Placeholder names that appear anywhere in `value`. */
export function placeholdersIn(value: unknown): string[] {
  const out = new Set<string>();
  walk(value, (s) => {
    for (const m of s.matchAll(PLACEHOLDER)) out.add(m[1]!);
    return s;
  });
  return [...out];
}

/**
 * Returns a deep copy of `value` with every `${NAME}` replaced from `secrets`.
 * Throws MissingSecretsError when a placeholder has no value, unless `partial` is set.
 */
export function substituteSecrets<T>(value: T, secrets: Record<string, string | undefined>, opts: { partial?: boolean } = {}): T {
  const missing = new Set<string>();
  const out = walk(value, (s) =>
    s.replace(PLACEHOLDER, (whole, name: string) => {
      const v = secrets[name];
      if (v == null) {
        missing.add(name);
        return whole;
      }
      return v;
    }),
  ) as T;
  if (missing.size > 0 && !opts.partial) throw new MissingSecretsError([...missing]);
  return out;
}

function walk(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, f));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = walk(v, f);
    return o;
  }
  return value;
}
