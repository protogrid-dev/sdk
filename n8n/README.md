# @protogrid/n8n-nodes-protogrid

An [n8n](https://n8n.io) community node for [protogrid](https://protogrid.dev), the MCP registry for agents.
It finds MCP servers by what they do, checks a server against rules you set, and gives you the connection to put in n8n's MCP Client Tool.
It works as a regular node and as a tool for the AI Agent, so the agent can look for a server and check it itself.

## Installation

In n8n, open **Settings > Community Nodes**, select **Install**, and enter `@protogrid/n8n-nodes-protogrid`.
See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

## Operations

**Server**

- **Search**: finds MCP servers by what they do, best match first, with each server's connection class, quality and trust scores, flags and the tools that matched. One item per server.
- **Check Against Rules**: whether one server passes your rules, with every rule it breaks.
- **Get Connection**: the endpoint URL, server transport and headers to set in the MCP Client Tool. Secrets appear as `${NAME}` placeholders; replace them with values you hold. protogrid never receives them.

Search and Check Against Rules share the rules:

- **Connection Classes**: R0 (nothing to set up), R1 (needs a key) and R2 (needs a sign-in, which the MCP Client Tool's MCP OAuth2 handles). Local packages are left out: the MCP Client Tool connects to remote servers only.
- **Exclude Servers Flagged For**: known vulnerabilities, hidden text, tool poisoning (all three by default) and an outdated MCP SDK.
- **Options**: minimum quality score, minimum trust score, owner verified only, and leaving out servers that charge per call.

As a tool, the rules are the ones you set in the node; the model only fills the fields you hand to it with `$fromAI`.

## Example workflows

**From a search to the MCP Client Tool.**
Three Protogrid nodes in a row find a server, check it and return its connection:

1. **Search** with Query `send an email`.
2. **Check Against Rules** with Server Name `{{ $json.name }}`.
3. **Get Connection** with Server Name `{{ $json.server }}`.

Set the MCP Client Tool's **Endpoint**, **Server Transport** and, for a server that needs a key, a Header Auth credential from the last output.

**An agent that finds its own server.**
Connect two Protogrid nodes to an AI Agent's **Tool** input:

1. **Search** with Query `{{ $fromAI('query', 'What the MCP server should do, in plain words', 'string') }}`.
2. **Check Against Rules** with Server Name `{{ $fromAI('server', 'The registry name of the server to check', 'string') }}`.

Ask the agent for a server that can do a task: it searches, checks the best match against your rules and answers with a server that passes.

## Credentials

The node works without a credential, at the anonymous limits.
A free API key raises them: sign in at [protogrid.dev/account](https://protogrid.dev/account), create a key, and add it to a **Protogrid API** credential.
A key that is malformed, unknown or revoked fails the credential test.
See [API keys and limits](https://docs.protogrid.dev/reference/api-keys/).

## Compatibility

Tested with n8n 2.49.

## Resources

- [protogrid docs: n8n](https://docs.protogrid.dev/sdk/n8n/)
- [REST API reference](https://docs.protogrid.dev/reference/rest-api/)
- [n8n MCP Client Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)

MIT licensed.
