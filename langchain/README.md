# langchain-protogrid

LangChain tools from the [protogrid](https://protogrid.dev) MCP registry: find MCP servers by what they do, check them against your rules, and give your agent the tools of the ones that pass.

```bash
pip install langchain-protogrid
```

```python
from langchain.agents import create_agent
from langchain_protogrid import Rules, load_tools

tools = await load_tools(
    "send an email",
    rules=Rules(min_quality=70),          # also refuses hidden text, tool poisoning, known vulnerabilities and paid servers
    secrets={"api_key": os.environ["MAIL_API_KEY"]},
)
agent = create_agent(model="anthropic:claude-sonnet-5", tools=tools)
```

- `load_tools` tries the best search results (or the `servers` you name) in order. Each goes through protogrid's gate with your rules; one that passes is connected to directly, with no proxy, and its tools come back named `<server key>_<tool>`.
- Secrets fill the `${NAME}` placeholders of the server's connection in your process; they are never sent to protogrid. A server needing a secret you did not give is passed over.
- Rules are yours, not the model's. The defaults refuse tools that hide text from people, tools holding instructions aimed at the model, servers with a known vulnerability in their dependencies, and servers that charge per call (x402), which an agent without a wallet cannot use (`Rules(paid=None)` accepts them, from 0.1.2). Local packages are never loaded.
- `pins={"io.github.owner/server": "<tools_hash>"}` passes over a server whose checked tools changed since you reviewed them; `strict_tools=True` also compares the tools the server lists right now with the ones protogrid checked.
- `ProtogridSearch()` and `ProtogridGate(rules=...)` let the agent look for servers and check one itself.

Python 3.11 or later. MCP support comes from `langchain[mcp]` (`langchain.mcp`, in beta upstream). Full guide: [docs.protogrid.dev/sdk/langchain](https://docs.protogrid.dev/sdk/langchain/).

MIT licensed.
