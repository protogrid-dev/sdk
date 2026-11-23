#!/usr/bin/env node
/** protogridctl: find MCP servers in the protogrid registry and add them to an MCP client, checked first. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createApi } from "./api.js";
import { CLIENTS, envFromProcess } from "./clients.js";
import { add, CliError, listClients, remove, search, type Deps } from "./commands.js";
import { terminalPrompter } from "./prompt.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `protogridctl ${VERSION}: add MCP servers to your client from the protogrid registry, checked first.

Usage:
  protogridctl search <words...> [--limit N]
  protogridctl add <server> --client <client> [--scope user|project] [--yes] [--no-prompt] [--min-quality N] [--dry-run]
  protogridctl remove <server> --client <client> [--scope user|project] [--dry-run]
  protogridctl clients

Clients: ${CLIENTS.map((c) => c.id).join(", ")}

add checks the server first (quality, hidden text, instructions aimed at the model, known vulnerabilities) and asks
before installing one that fails; --min-quality refuses a lower score. Keys and tokens are asked for and written only
to your client's config file; nothing you type is sent to protogrid. The previous file is kept as <file>.bak.

Environment: PROTOGRID_API_URL (default https://api.protogrid.dev), PROTOGRID_API_KEY (optional, raises limits).
Docs: https://docs.protogrid.dev/guides/install-cli/`;

export async function main(argv: string[], deps?: Partial<Deps>): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        client: { type: "string", short: "c" },
        scope: { type: "string", default: "user" },
        yes: { type: "boolean", short: "y", default: false },
        "no-prompt": { type: "boolean", default: false },
        "min-quality": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string", default: "10" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  const { values: v, positionals: [command, ...rest] } = parsed;
  const out = deps?.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (v.version) return out(VERSION), 0;
  if (v.help || !command) return out(HELP), command || v.help ? 0 : 2;

  const d: Deps = {
    api: deps?.api ?? createApi({ baseUrl: process.env["PROTOGRID_API_URL"], apiKey: process.env["PROTOGRID_API_KEY"], version: VERSION }),
    prompter: deps?.prompter ?? terminalPrompter(),
    env: deps?.env ?? envFromProcess(),
    out,
    runClaude:
      deps?.runClaude ??
      ((args) => {
        const r = spawnSync("claude", args, { encoding: "utf8", shell: false });
        return { status: r.status, notFound: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT", stderr: r.stderr ?? "" };
      }),
  };
  const scope = v.scope === "project" ? "project" : v.scope === "user" ? "user" : null;
  try {
    if (!scope) throw new CliError(`--scope is user or project, not "${v.scope}"`, 2);
    const needClient = () => {
      if (!v.client) throw new CliError(`--client is required: one of ${CLIENTS.map((c) => c.id).join(", ")}`, 2);
      return v.client;
    };
    const needName = () => {
      if (rest.length !== 1) throw new CliError(`give one server name, such as io.github.owner/server; find one with: protogridctl search <words>`, 2);
      return rest[0]!;
    };
    switch (command) {
      case "search": {
        if (rest.length === 0) throw new CliError("search needs some words, such as: protogridctl search send email", 2);
        const limit = Number(v.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CliError("--limit is a whole number from 1 to 50", 2);
        await search(rest.join(" "), limit, d);
        break;
      }
      case "add": {
        const min = v["min-quality"];
        const minQuality = min == null ? undefined : Number(min);
        if (minQuality != null && (!Number.isInteger(minQuality) || minQuality < 0 || minQuality > 100)) throw new CliError("--min-quality is a whole number from 0 to 100", 2);
        await add(needName(), { client: needClient(), scope, yes: v.yes, prompt: !v["no-prompt"], minQuality, dryRun: v["dry-run"] }, d);
        break;
      }
      case "remove":
        await remove(needName(), { client: needClient(), scope, dryRun: v["dry-run"] }, d);
        break;
      case "clients":
        listClients(d);
        break;
      default:
        throw new CliError(`unknown command "${command}"\n\n${HELP}`, 2);
    }
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`protogridctl: ${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}

// Run when executed (npx, the bin link), not when imported by the tests.
const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (import.meta.url === invoked || /protogridctl$/.test(process.argv[1] ?? "")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`protogridctl: ${(e as Error).stack ?? e}\n`);
      process.exit(1);
    },
  );
}
