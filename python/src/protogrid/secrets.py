"""``${NAME}`` placeholder substitution. The registry never sees secret values; the caller
supplies them here, at the last moment, from whatever store it already has."""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, TypeVar

PLACEHOLDER = re.compile(r"\$\{([A-Za-z0-9_.-]+)\}")
T = TypeVar("T")


class MissingSecretsError(KeyError):
    def __init__(self, missing: list[str]):
        super().__init__(f"missing secrets: {', '.join(missing)}")
        self.missing = missing


def placeholders_in(value: Any) -> list[str]:
    """Placeholder names that appear anywhere in ``value`` (strings, lists, dicts)."""
    out: dict[str, None] = {}

    def visit(v: Any) -> None:
        if isinstance(v, str):
            for m in PLACEHOLDER.finditer(v):
                out.setdefault(m.group(1))
        elif isinstance(v, list):
            for x in v:
                visit(x)
        elif isinstance(v, dict):
            for x in v.values():
                visit(x)

    visit(value)
    return list(out)


def substitute_secrets(value: T, secrets: Mapping[str, str | None], *, partial: bool = False) -> T:
    """Deep copy of ``value`` with every ``${NAME}`` replaced from ``secrets``.

    Raises :class:`MissingSecretsError` when a placeholder has no value, unless ``partial``.
    """
    missing: dict[str, None] = {}

    def repl(m: re.Match[str]) -> str:
        v = secrets.get(m.group(1))
        if v is None:
            missing.setdefault(m.group(1))
            return m.group(0)
        return v

    def visit(v: Any) -> Any:
        if isinstance(v, str):
            return PLACEHOLDER.sub(repl, v)
        if isinstance(v, list):
            return [visit(x) for x in v]
        if isinstance(v, dict):
            return {k: visit(x) for k, x in v.items()}
        return v

    out = visit(value)
    if missing and not partial:
        raise MissingSecretsError(list(missing))
    return out
