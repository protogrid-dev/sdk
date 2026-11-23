# protogridctl

Add MCP servers from the [protogrid](https://protogrid.dev) registry to your MCP client, checked before they are installed.

```bash
npx protogridctl search send email
npx protogridctl add io.github.owner/server --client cursor
```

Clients: `cursor`, `vscode`, `claude-code`, `claude-desktop`, `gemini`, `codex`, `opencode`, `goose`.

- `add` shows the server's quality score, connection class and owner, and asks before installing a server that hides text in its tools, holds instructions aimed at the model, or depends on a package with a known vulnerability. `--min-quality N` refuses lower scores. A server that charges per call (x402) is named as such.
- Keys and tokens are asked for without echo and written only to your client's config file. Nothing you type is sent to protogrid.
- Every other entry in the file is kept; the previous file stays as `<file>.bak`. A file with comments is never rewritten.
- `--scope project` writes the project's file, `--dry-run` shows the change and writes nothing, `remove` takes an entry out.

Node.js 20 or later, no dependencies, no account. Full guide: [docs.protogrid.dev/guides/install-cli](https://docs.protogrid.dev/guides/install-cli/).

MIT licensed.
