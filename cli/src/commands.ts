/**
 * What each command does, with its outside world injected (API, terminal, files' home, the `claude` command) so the
 * tests run it end to end on temporary directories.
 */
import { existsSync, readFileSync } from "node:fs";
import { ApiError, type Api, type Connection } from "./api.js";
import { CLIENTS, findClient, type ClientSpec, type Env, type Location, type Scope } from "./clients.js";
import { ConfigError, hasJsonEntry, hasTomlServer, jsonText, readJsonConfig, withJsonEntry, withoutJsonEntry, withoutTomlServer, withTomlServer, writeConfig } from "./files.js";
import type { Prompter } from "./prompt.js";

export interface Deps {
  api: Api;
  prompter: Prompter;
  env: Env;
  out: (line: string) => void;
  /** Runs `claude` with these arguments (never through a shell); `notFound` when it is not installed. */
  runClaude: (args: string[]) => { status: number | null; notFound: boolean; stderr: string };
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

export interface AddOptions {
  client: string;
  scope: Scope;
  yes: boolean;
  prompt: boolean;
  minQuality?: number | undefined;
  dryRun: boolean;
}

const CLASS_TEXT: Record<string, string> = {
  R0: "remote, nothing to set up",
  R1: "remote, needs a key or token you hold",
  R2: "remote, signs in with OAuth in your client",
  L0: "local package that runs on your machine",
};

/** Problems that a confirmation may accept; a score under `--min-quality` or a blocked listing is refused outright. */
const HARD_RULES = new Set(["min_quality", "listing"]);

function client(id: string): ClientSpec {
  const c = findClient(id);
  if (!c) throw new CliError(`unknown client "${id}"; one of: ${CLIENTS.map((x) => x.id).join(", ")}`, 2);
  return c;
}

function located(c: ClientSpec, env: Env, scope: Scope): Location {
  const loc = c.locate(env, scope);
  if (!loc) throw new CliError(`${c.label} has no ${scope} configuration; use --scope ${scope === "user" ? "project" : "user"}`, 2);
  return loc;
}

const apiMessage = (e: unknown, name: string): CliError => {
  if (e instanceof ApiError && e.status === 404) return new CliError(`no server named "${name}" in the registry; try: protogridctl search <words>`, 1);
  if (e instanceof ApiError) return new CliError(`the registry answered ${e.status}: ${e.message}`, 1);
  return new CliError(`the registry could not be reached: ${(e as Error).message}`, 1);
};

/** Replaces `${NAME}` in every string of `value` with the answers given. */
function fill(value: unknown, answers: Map<string, string>, escape: (s: string) => string = (s) => s): unknown {
  if (typeof value === "string") return value.replace(/\$\{([^}]+)\}/g, (all, n: string) => (answers.has(n) ? escape(answers.get(n)!) : all));
  if (Array.isArray(value)) return value.map((v) => fill(v, answers, escape));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, answers, escape)]));
  return value;
}

/** A TOML basic string's escapes, for a value placed inside the API's quotes. */
const tomlEscape = (s: string) => JSON.stringify(s).slice(1, -1);

export async function add(name: string, o: AddOptions, d: Deps): Promise<void> {
  const c = client(o.client);
  const loc = located(c, d.env, o.scope);

  // 1. Check the server before anything is written.
  const rules: Record<string, string> = { no_fail: "tools.hidden_text,tools.poisoning", exclude_quality_flags: "known-vulns" };
  if (o.minQuality != null) rules["min_quality"] = String(o.minQuality);
  let gate;
  try {
    gate = await d.api.gate(name, rules);
  } catch (e) {
    throw apiMessage(e, name);
  }
  d.out(`${gate.server}`);
  d.out(`  quality ${gate.quality.score == null ? "not scored yet" : `${gate.quality.score}${gate.quality.label ? ` (${gate.quality.label})` : ""}`} · trust ${gate.trust.score ?? "-"} · ${gate.class}: ${CLASS_TEXT[gate.class] ?? gate.class} · owner ${gate.owner_verified ? "verified" : "not verified"}`);
  if (gate.payment) d.out(`  charges per call (${gate.payment === "listed" ? "listed with prices in an x402 Bazaar" : "the server says so"}): your client needs a wallet that pays x402`);
  if (!gate.pass) {
    for (const f of gate.failed) d.out(`  ! ${f.detail}`);
    if (gate.failed.some((f) => HARD_RULES.has(f.rule))) throw new CliError("not installed", 3);
    if (!o.yes) {
      if (!d.prompter.interactive) throw new CliError("not installed: the checks above failed; rerun with --yes to install anyway", 3);
      if (!(await d.prompter.confirm("Install it anyway?"))) throw new CliError("not installed", 3);
    }
  }

  // 2. The entry in the client's own shape.
  let conn: Connection;
  try {
    conn = await d.api.connection(name, c.target);
  } catch (e) {
    if (e instanceof ApiError && [403, 409, 410].includes(e.status)) throw new CliError(`no connection offered: ${e.message}`, 1);
    throw apiMessage(e, name);
  }
  if (conn.kind === "bundle") {
    d.out(`This server ships as a bundle (.mcpb): open it with ${c.label} instead.`);
    return;
  }
  const generic = (conn.connection as Record<string, Record<string, unknown>> | null)?.[loc.rootKey ?? "mcpServers"];
  const entry = loc.format === "toml" || loc.format === "print" ? null : (generic?.[conn.key] ?? null);
  if (c.localOnly && conn.kind === "remote") {
    const url = (entry as { url?: string } | null)?.url;
    d.out(`${c.label} adds remote servers as connectors, not in its config file: Settings > Connectors > Add custom connector${url ? `, URL ${url}` : ""}.`);
    return;
  }
  if (loc.format !== "toml" && loc.format !== "print" && !entry) throw new CliError("the registry returned no entry for this client", 1);
  const text = typeof conn.connection === "string" ? conn.connection : "";
  // Smithery closed its hosting on 2026-10-31: such an address no longer answers.
  if (/https?:\/\/(server\.smithery\.ai|[^/"\s]*\.run\.tools)(\/|:|"|$)/i.test(entry ? JSON.stringify(entry) : text)) {
    d.out("  ! this address is on Smithery's hosting, closed on 31 October 2026, so it no longer answers; see https://docs.protogrid.dev/guides/moving-from-smithery/");
    if (!o.yes) {
      if (!d.prompter.interactive) throw new CliError("not installed: the address no longer answers; rerun with --yes to install anyway", 3);
      if (!(await d.prompter.confirm("Install it anyway?"))) throw new CliError("not installed", 3);
    }
  }

  // 3. Secrets: asked for, written only to the local file; the ones a client reads from the environment are named.
  const payload = entry ? JSON.stringify(entry) : text;
  const inline = conn.secrets.filter((s) => payload.includes(`\${${s.name}}`));
  const fromEnv = conn.secrets.filter((s) => !inline.includes(s));
  const answers = new Map<string, string>();
  if (inline.length > 0 && o.prompt && d.prompter.interactive && !o.dryRun && loc.format !== "print") {
    for (const s of inline) {
      const v = await d.prompter.secret(`${s.name} (${s.where}, written only to your ${c.label} config; empty keeps the placeholder): `);
      if (v) answers.set(s.name, v);
    }
  }
  const missing = inline.filter((s) => !answers.has(s.name));

  if (loc.format === "print") {
    d.out(`Add this to ${loc.path}:`);
    d.out(text.replace(/\s+$/, ""));
    return;
  }

  // 4. Write it.
  const secret = answers.size > 0;
  if (loc.format === "command") {
    const json = JSON.stringify(fill(entry, answers));
    const args = ["mcp", "add-json", conn.key, json, "--scope", "user"];
    if (o.dryRun) {
      d.out(`Would run: claude mcp add-json ${conn.key} '${JSON.stringify(entry)}' --scope user`);
      return;
    }
    const r = d.runClaude(args);
    if (r.notFound) throw new CliError(`the claude command was not found; run: claude mcp add-json ${conn.key} '${JSON.stringify(entry)}' --scope user`, 1);
    if (r.status !== 0) throw new CliError(`claude mcp add-json failed: ${r.stderr.trim() || `exit ${r.status}`}`, 1);
    d.out(`Added "${conn.key}" to Claude Code (user scope).`);
  } else {
    const path = loc.path!;
    let content: string;
    let exists: boolean;
    try {
      if (loc.format === "toml") {
        const current = existsSync(path) ? readFileSync(path, "utf8") : "";
        exists = hasTomlServer(current, conn.key);
        content = withTomlServer(current, conn.key, String(fill(text, answers, tomlEscape)));
      } else {
        const doc = readJsonConfig(path);
        exists = hasJsonEntry(doc, loc.rootKey!, conn.key, path);
        content = jsonText(withJsonEntry(doc, loc.rootKey!, conn.key, fill(entry, answers), path, loc.newFile));
      }
    } catch (e) {
      if (e instanceof ConfigError) throw new CliError(e.message, 1);
      throw e;
    }
    if (exists && !o.yes && !o.dryRun) {
      if (!d.prompter.interactive) throw new CliError(`"${conn.key}" is already in ${path}; rerun with --yes to replace it`, 1);
      if (!(await d.prompter.confirm(`"${conn.key}" is already in ${path}. Replace it?`))) throw new CliError("left as it was", 1);
    }
    if (o.dryRun) {
      d.out(`Would ${exists ? "replace" : "add"} "${conn.key}" in ${path}:`);
      d.out(loc.format === "toml" ? text.replace(/\s+$/, "") : JSON.stringify(entry, null, 2));
      return;
    }
    const { backup } = writeConfig(path, content, { secret });
    d.out(`${exists ? "Replaced" : "Added"} "${conn.key}" in ${path}${backup ? ` (previous file kept as ${backup})` : ""}.`);
  }

  if (missing.length > 0) d.out(`Fill in before use: ${missing.map((s) => `\${${s.name}}`).join(", ")} (${missing.map((s) => s.where).join(", ")}).`);
  if (fromEnv.length > 0) d.out(`${c.label} reads ${fromEnv.map((s) => s.name).join(", ")} from the environment: set ${fromEnv.length === 1 ? "it" : "them"} before starting it.`);
  if (conn.kind === "package") d.out("This server runs as a local package on your machine when the client starts it.");
  if (gate.class === "R2") d.out(`${c.label} will open a sign-in page the first time it connects.`);
  d.out(`Restart ${c.label} or reload its MCP servers to use it.`);
}

export async function remove(nameOrKey: string, o: { client: string; scope: Scope; dryRun: boolean }, d: Deps): Promise<void> {
  const c = client(o.client);
  const loc = located(c, d.env, o.scope);
  // A registry name gives the key the API used when adding it; anything else is taken as the key itself.
  let key = nameOrKey;
  if (nameOrKey.includes("/")) {
    try {
      key = (await d.api.connection(nameOrKey, c.target)).key;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw apiMessage(e, nameOrKey);
    }
  }
  if (loc.format === "print") throw new CliError(`remove "${key}" from ${loc.path} by hand`, 1);
  if (loc.format === "command") {
    if (o.dryRun) return d.out(`Would run: claude mcp remove ${key} --scope user`);
    const r = d.runClaude(["mcp", "remove", key, "--scope", "user"]);
    if (r.notFound) throw new CliError(`the claude command was not found; run: claude mcp remove ${key} --scope user`, 1);
    if (r.status !== 0) throw new CliError(`claude mcp remove failed: ${r.stderr.trim() || `exit ${r.status}`}`, 1);
    return d.out(`Removed "${key}" from Claude Code (user scope).`);
  }
  const path = loc.path!;
  try {
    if (loc.format === "toml") {
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (!hasTomlServer(current, key)) throw new CliError(`"${key}" is not in ${path}`, 1);
      if (o.dryRun) return d.out(`Would remove "${key}" from ${path}.`);
      const { backup } = writeConfig(path, withoutTomlServer(current, key), { secret: false });
      return d.out(`Removed "${key}" from ${path} (previous file kept as ${backup}).`);
    }
    const doc = readJsonConfig(path);
    if (!doc || !hasJsonEntry(doc, loc.rootKey!, key, path)) throw new CliError(`"${key}" is not in ${path}`, 1);
    if (o.dryRun) return d.out(`Would remove "${key}" from ${path}.`);
    const { backup } = writeConfig(path, jsonText(withoutJsonEntry(doc, loc.rootKey!, key, path)), { secret: false });
    d.out(`Removed "${key}" from ${path} (previous file kept as ${backup}).`);
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError(e.message, 1);
    throw e;
  }
}

export async function search(q: string, limit: number, d: Deps): Promise<void> {
  let results;
  try {
    results = await d.api.search(q, limit);
  } catch (e) {
    throw apiMessage(e, q);
  }
  if (results.length === 0) return d.out("No servers found.");
  for (const r of results) {
    const facts = [r.connection_class, r.quality_score != null ? `quality ${r.quality_score}` : null, r.owner_verified ? "owner verified" : null, ...(r.quality_flags ?? [])].filter(Boolean);
    d.out(`${r.name}  ${facts.join(" · ")}`);
    const about = (r.title || r.description || "").replace(/\s+/g, " ").trim();
    if (about) d.out(`  ${about.length > 110 ? `${about.slice(0, 107)}...` : about}`);
  }
  d.out(`\nAdd one: protogridctl add <name> --client <${CLIENTS.map((c) => c.id).join("|")}>`);
}

export function listClients(d: Deps): void {
  for (const c of CLIENTS) {
    const where = (s: Scope) => {
      const l = c.locate(d.env, s);
      return !l ? "-" : l.format === "command" ? "claude mcp add-json" : l.format === "print" ? `${l.path} (printed, not written)` : l.path!;
    };
    d.out(`${c.id.padEnd(15)} ${c.label}`);
    d.out(`  user:    ${where("user")}`);
    d.out(`  project: ${where("project")}`);
  }
}
