"""End to end, no human: find a server for an intent, connect, call a tool you did not know existed.

    uv run python examples/find_and_call.py "get the current weather for a city" Madrid

Uses the public registry; set REGISTRY_URL=http://localhost:8080 for a local stack.
Secrets for R1 servers come from the environment: any ${NAME} placeholder is read from os.environ[NAME].
"""
from __future__ import annotations

import asyncio
import os
import sys

from protogrid import ProtogridClient, find_connectable, open_session


def args_for(schema: dict, string_value: str) -> dict | None:
    out: dict = {}
    props = schema.get("properties") or {}
    for r in schema.get("required") or []:
        p = props.get(r) or {}
        if "default" in p:
            out[r] = p["default"]
        elif p.get("enum"):
            out[r] = p["enum"][0]
        elif p.get("type") == "string":
            out[r] = string_value
        elif p.get("type") in ("number", "integer"):
            out[r] = 1
        elif p.get("type") == "boolean":
            out[r] = True
        else:
            return None
    return out


async def main() -> int:
    intent = sys.argv[1] if len(sys.argv) > 1 else "get the current weather for a city"
    string_value = sys.argv[2] if len(sys.argv) > 2 else intent
    registry = ProtogridClient(**({"base_url": os.environ["REGISTRY_URL"]} if os.environ.get("REGISTRY_URL") else {}))
    found = find_connectable(registry, intent, secrets=os.environ)
    if not found:
        print(f'nothing autonomous found for "{intent}"')
        return 1
    r = found.result
    print(f"→ {r['name']} ({r['connection_class']}, trust {r['trust_score']}); matched: {', '.join(t['name'] for t in r['matched_tools']) or 'server text'}")
    async with open_session(found.connection, os.environ) as session:
        tools = (await session.list_tools()).tools
        print(f"connected; {len(tools)} tools: {', '.join(t.name for t in tools[:8])}{', …' if len(tools) > 8 else ''}")
        matched = [t for m in r["matched_tools"] for t in tools if t.name == m["name"]]
        for t in [*matched, *tools]:
            a = args_for(getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {}, string_value)
            if a is None:
                continue
            print(f"calling {t.name} with {a}")
            out = await session.call_tool(t.name, a)
            text = "\n".join(getattr(c, "text", "") for c in out.content)
            print("tool error:" if getattr(out, "is_error", getattr(out, "isError", False)) else "result:", text[:600])
            break
        else:
            print("no tool callable without more information; stopping here")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
