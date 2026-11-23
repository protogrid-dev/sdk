"""protogrid's tool-set hash, computed on the tools a server lists right now, to compare with the set protogrid checked.

The same canonical form as the registry: per tool, JSON with sorted keys of its name, title, description, input
schema, output schema and annotations (absent ones as null, a missing description as an empty string), SHA-256
truncated to 32 hex characters; the set hash is the same digest over the sorted ``name NUL hash`` lines.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any


def _stable(value: Any) -> str:
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{_stable(v)}" for k, v in sorted(value.items())) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_stable(v) for v in value) + "]"
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, float) and value.is_integer():
        # JavaScript prints 1.0 as 1.
        return str(int(value))
    return json.dumps(value, ensure_ascii=False)



def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:32]


def tool_hash(tool: Mapping[str, Any]) -> str:
    canonical = {
        "name": tool.get("name"),
        "title": tool.get("title"),
        "description": tool.get("description") or "",
        "inputSchema": tool.get("inputSchema"),
        "outputSchema": tool.get("outputSchema"),
        "annotations": tool.get("annotations"),
    }
    return _sha(_stable(canonical))


def tool_set_hash(tools: Iterable[Mapping[str, Any]]) -> str | None:
    seen: dict[str, str] = {}
    for t in tools:
        name = t.get("name")
        if isinstance(name, str) and name and name not in seen:
            seen[name] = tool_hash(t)
    if not seen:
        return None
    return _sha("\n".join(sorted(f"{n}\u0000{h}" for n, h in seen.items())))
