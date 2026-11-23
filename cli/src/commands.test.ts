/** protogridctl end to end on temporary directories, with a scripted registry and terminal. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, type Api, type Connection, type Gate } from "./api.js";
import { main } from "./cli.js";
import type { Env } from "./clients.js";
import type { Deps } from "./commands.js";
import { hasTomlServer, withoutTomlServer, withTomlServer } from "./files.js";

const pass: Gate = { server: "io.github.acme/mail", pass: true, failed: [], quality: { score: 88, label: "good", flags: [] }, trust: { score: 90, flags: [] }, class: "R1", owner_verified: true };

/** The API's answer for each target, for a remote that needs a bearer token. */
function remote(target: string): Connection {
  const entry = { type: "http", url: "https://mail.acme.dev/mcp", headers: { Authorization: "Bearer ${MAIL_TOKEN}" } };
  const connection =
    target === "codex-toml"
      ? '[mcp_servers.mail]\nurl = "https://mail.acme.dev/mcp"\nbearer_token_env_var = "MAIL_TOKEN"\n'
      : target === "goose"
        ? 'extensions:\n  "mail":\n    uri: "https://mail.acme.dev/mcp"\n'
        : target === "vscode"
          ? { servers: { mail: entry } }
          : target === "opencode"
            ? { $schema: "https://opencode.ai/config.json", mcp: { mail: { type: "remote", url: "https://mail.acme.dev/mcp", headers: entry.headers } } }
            : { mcpServers: { mail: entry } };
  return { server: "io.github.acme/mail", key: "mail", kind: "remote", class: "R1", content_type: typeof connection === "string" ? "text/plain" : "application/json", connection, secrets: [{ name: "MAIL_TOKEN", where: "header:Authorization" }] };
}

let home: string;
let cwd: string;
let lines: string[];
let gate: Gate;
let conn: (target: string) => Connection;
let answers: { confirm: boolean[]; secret: string[] };
let interactive: boolean;
let claudeCalls: string[][];

const api: Api = {
  gate: async (name, rules) => {
    if (name === "io.github.acme/missing") throw new ApiError(404, "not_found", "no such server");
    return { ...gate, ...(rules["min_quality"] && Number(rules["min_quality"]) > (gate.quality.score ?? 0) ? { pass: false, failed: [...gate.failed, { rule: "min_quality", detail: `quality ${gate.quality.score} is under ${rules["min_quality"]}` }] } : {}) };
  },
  connection: async (_name, target) => conn(target),
  search: async () => [{ name: "io.github.acme/mail", title: "Mail", connection_class: "R1", quality_score: 88 }],
};

const run = (...argv: string[]) => {
  const env: Env = { home, cwd, platform: "linux", xdgConfig: join(home, ".config") };
  const deps: Partial<Deps> = {
    api,
    env,
    out: (l) => void lines.push(l),
    prompter: { interactive, confirm: async () => answers.confirm.shift() ?? false, secret: async () => answers.secret.shift() ?? "" },
    runClaude: (args) => (claudeCalls.push(args), { status: 0, notFound: false, stderr: "" }),
  };
  return main(argv, deps);
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pgctl-home-"));
  cwd = mkdtempSync(join(tmpdir(), "pgctl-cwd-"));
  lines = [];
  gate = pass;
  conn = remote;
  answers = { confirm: [], secret: [] };
  interactive = true;
  claudeCalls = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("add", () => {
  it("asks for the token and writes it only to the client's file, private, keeping the other servers", async () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: "https://x.dev" } }, theme: "dark" }));
    answers.secret = ['s3cr"et'];
    expect(await run("add", "io.github.acme/mail", "--client", "cursor")).toBe(0);
    expect(json(path)).toEqual({ mcpServers: { other: { url: "https://x.dev" }, mail: { type: "http", url: "https://mail.acme.dev/mcp", headers: { Authorization: 'Bearer s3cr"et' } } }, theme: "dark" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).mcpServers.mail).toBeUndefined();
    expect(lines.join("\n")).not.toContain("s3cr");
  });

  it("keeps the placeholder with --no-prompt or without a terminal, and says what to fill in", async () => {
    for (const [flag, tty] of [["--no-prompt", true], ["--yes", false]] as const) {
      interactive = tty;
      lines = [];
      expect(await run("add", "io.github.acme/mail", "--client", "gemini", flag)).toBe(0);
      expect(json(join(home, ".gemini", "settings.json")).mcpServers.mail.headers.Authorization).toBe("Bearer ${MAIL_TOKEN}");
      expect(lines.join("\n")).toContain("Fill in before use: ${MAIL_TOKEN}");
    }
  });

  it("stops before writing when the server fails the checks, unless confirmed", async () => {
    gate = { ...pass, pass: false, failed: [{ rule: "no_fail", detail: "tools.hidden_text fails" }] };
    const path = join(home, ".cursor", "mcp.json");
    interactive = false;
    expect(await run("add", "io.github.acme/mail", "--client", "cursor")).toBe(3);
    expect(existsSync(path)).toBe(false);
    interactive = true;
    answers.confirm = [false];
    expect(await run("add", "io.github.acme/mail", "--client", "cursor")).toBe(3);
    expect(existsSync(path)).toBe(false);
    answers.confirm = [true];
    expect(await run("add", "io.github.acme/mail", "--client", "cursor", "--no-prompt")).toBe(0);
    expect(lines).toContain("  ! tools.hidden_text fails");
    expect(existsSync(path)).toBe(true);
  });

  it("says when a server charges per call", async () => {
    gate = { ...pass, payment: "listed" };
    expect(await run("add", "io.github.acme/mail", "--client", "cursor", "--no-prompt")).toBe(0);
    expect(lines.join("\n")).toContain("charges per call (listed with prices in an x402 Bazaar)");
  });

  it("refuses a score under --min-quality even with --yes", async () => {
    expect(await run("add", "io.github.acme/mail", "--client", "cursor", "--min-quality", "90", "--yes")).toBe(3);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(await run("add", "io.github.acme/mail", "--client", "cursor", "--min-quality", "80", "--yes")).toBe(0);
  });

  it("asks before replacing an entry of the same name, and needs --yes without a terminal", async () => {
    const path = join(cwd, ".vscode", "mcp.json");
    mkdirSync(join(cwd, ".vscode"));
    writeFileSync(path, JSON.stringify({ servers: { mail: { url: "https://old" } } }));
    interactive = false;
    expect(await run("add", "io.github.acme/mail", "--client", "vscode", "--scope", "project")).toBe(1);
    expect(json(path).servers.mail.url).toBe("https://old");
    expect(await run("add", "io.github.acme/mail", "--client", "vscode", "--scope", "project", "--yes")).toBe(0);
    expect(json(path).servers.mail.url).toBe("https://mail.acme.dev/mcp");
  });

  it("leaves a file with comments untouched", async () => {
    const path = join(home, ".config", "Code", "User", "mcp.json");
    mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
    const text = '{\n  // mine\n  "servers": {}\n}\n';
    writeFileSync(path, text);
    expect(await run("add", "io.github.acme/mail", "--client", "vscode", "--no-prompt")).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("writes nothing on --dry-run and asks for no secret", async () => {
    answers.secret = ["never"];
    expect(await run("add", "io.github.acme/mail", "--client", "opencode", "--dry-run")).toBe(0);
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(answers.secret).toEqual(["never"]);
    expect(lines.join("\n")).toContain("Would add \"mail\"");
  });

  it("starts a new opencode file with its schema", async () => {
    expect(await run("add", "io.github.acme/mail", "--client", "opencode", "--no-prompt")).toBe(0);
    expect(json(join(home, ".config", "opencode", "opencode.json"))).toMatchObject({ $schema: "https://opencode.ai/config.json", mcp: { mail: { type: "remote" } } });
  });

  it("replaces Codex's table and its subtables, keeps the rest, and names the variable Codex reads", async () => {
    const path = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"));
    writeFileSync(path, 'model = "o4"\n\n[mcp_servers.mail]\nurl = "https://old"\n\n[mcp_servers.mail.env]\nX = "1"\n\n[mcp_servers.other]\nurl = "https://o"\n');
    expect(await run("add", "io.github.acme/mail", "--client", "codex", "--yes")).toBe(0);
    const text = readFileSync(path, "utf8");
    expect(text).toBe('model = "o4"\n\n[mcp_servers.other]\nurl = "https://o"\n\n[mcp_servers.mail]\nurl = "https://mail.acme.dev/mcp"\nbearer_token_env_var = "MAIL_TOKEN"\n');
    expect(lines.join("\n")).toContain("Codex reads MAIL_TOKEN from the environment");
    expect(await run("remove", "mail", "--client", "codex")).toBe(0);
    expect(readFileSync(path, "utf8")).toBe('model = "o4"\n\n[mcp_servers.other]\nurl = "https://o"\n');
  });

  it("adds through `claude mcp add-json` for Claude Code's user scope, never a shell", async () => {
    answers.secret = ["tok"];
    expect(await run("add", "io.github.acme/mail", "--client", "claude-code")).toBe(0);
    expect(claudeCalls).toEqual([["mcp", "add-json", "mail", JSON.stringify({ type: "http", url: "https://mail.acme.dev/mcp", headers: { Authorization: "Bearer tok" } }), "--scope", "user"]]);
  });

  it("points Claude Desktop to its connectors for a remote server, and writes local ones", async () => {
    expect(await run("add", "io.github.acme/mail", "--client", "claude-desktop", "--no-prompt")).toBe(0);
    expect(lines.join("\n")).toContain("Add custom connector, URL https://mail.acme.dev/mcp");
    expect(existsSync(join(home, ".config", "Claude", "claude_desktop_config.json"))).toBe(false);
    conn = () => ({ server: "io.github.acme/files", key: "files", kind: "package", class: "L0", content_type: "application/json", connection: { mcpServers: { files: { command: "npx", args: ["-y", "files-mcp@1.0.0"] } } }, secrets: [] });
    expect(await run("add", "io.github.acme/files", "--client", "claude-desktop")).toBe(0);
    expect(json(join(home, ".config", "Claude", "claude_desktop_config.json")).mcpServers.files.command).toBe("npx");
    expect(lines.join("\n")).toContain("runs as a local package");
  });

  it("warns before installing an address on Smithery's closed hosting", async () => {
    conn = () => ({ ...remote("cursor"), connection: { mcpServers: { mail: { type: "http", url: "https://server.smithery.ai/acme/mail/mcp" } } }, secrets: [] });
    interactive = false;
    expect(await run("add", "io.github.acme/mail", "--client", "cursor")).toBe(3);
    expect(lines.join("\n")).toContain("Smithery's hosting");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(await run("add", "io.github.acme/mail", "--client", "cursor", "--yes")).toBe(0);
  });

  it("prints Goose's YAML instead of editing it", async () => {
    expect(await run("add", "io.github.acme/mail", "--client", "goose")).toBe(0);
    expect(lines.join("\n")).toContain(`Add this to ${join(home, ".config", "goose", "config.yaml")}`);
  });

  it("explains a server that is not in the registry and an unknown client", async () => {
    expect(await run("add", "io.github.acme/missing", "--client", "cursor")).toBe(1);
    expect(await run("add", "io.github.acme/mail", "--client", "emacs")).toBe(2);
    expect(await run("add", "io.github.acme/mail", "--client", "codex", "--scope", "project")).toBe(2);
  });
});

describe("remove and search", () => {
  it("removes by registry name or key and says when it is not there", async () => {
    await run("add", "io.github.acme/mail", "--client", "cursor", "--no-prompt");
    expect(await run("remove", "io.github.acme/mail", "--client", "cursor")).toBe(0);
    expect(json(join(home, ".cursor", "mcp.json")).mcpServers).toEqual({});
    expect(await run("remove", "mail", "--client", "cursor")).toBe(1);
  });

  it("lists matches with what decides the choice", async () => {
    expect(await run("search", "send", "mail")).toBe(0);
    expect(lines[0]).toBe("io.github.acme/mail  R1 · quality 88");
  });
});

describe("Codex tables", () => {
  it("finds quoted keys and leaves look-alikes alone", () => {
    const text = '[mcp_servers."my.mail"]\nurl = "a"\n\n[mcp_servers.mail2]\nurl = "b"\n';
    expect(hasTomlServer(text, "my.mail")).toBe(true);
    expect(hasTomlServer(text, "mail")).toBe(false);
    expect(withoutTomlServer(text, "my.mail")).toBe('[mcp_servers.mail2]\nurl = "b"\n');
    expect(withTomlServer("", "x", "[mcp_servers.x]\nurl = \"u\"\n")).toBe('[mcp_servers.x]\nurl = "u"\n');
  });
});
