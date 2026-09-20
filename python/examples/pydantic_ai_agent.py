"""PydanticAI flagship: a registry-found MCP server becomes a toolset of an agent.

    uv run python examples/pydantic_ai_agent.py "get the current weather for a city"

Uses the public registry; set REGISTRY_URL=http://localhost:8080 for a local stack.
Uses PydanticAI's TestModel so it runs without an LLM key; swap the model for a real one to let the
model choose and call the tools. R1 secrets come from the environment.
"""
from __future__ import annotations

import asyncio
import os
import sys

from pydantic_ai import Agent
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.models.test import TestModel

from protogrid import ProtogridClient, find_connectable, to_pydantic_ai


async def main() -> int:
    intent = sys.argv[1] if len(sys.argv) > 1 else "get the current weather for a city"
    registry = ProtogridClient(**({"base_url": os.environ["REGISTRY_URL"]} if os.environ.get("REGISTRY_URL") else {}))
    found = find_connectable(registry, intent, secrets=os.environ)
    if not found:
        print(f'nothing autonomous found for "{intent}"')
        return 1
    print(f"→ {found.result['name']} ({found.result['connection_class']}, trust {found.result['trust_score']})")
    toolset = to_pydantic_ai(found.connection, os.environ)
    # TestModel calls every available tool once with schema-derived arguments, so the run shows
    # the agent using tools it learned about from the registry, with no LLM key.
    agent = Agent(TestModel(), toolsets=[toolset])
    async with agent:
        result = await agent.run(intent)
    calls = [p for m in result.all_messages() for p in m.parts if isinstance(p, ToolCallPart)]
    print(f"agent called {len(calls)} registry-found tools: {', '.join(c.tool_name for c in calls)}")
    print("run finished:", str(result.output)[:160])
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
