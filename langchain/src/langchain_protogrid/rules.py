"""The rules a server must pass before an agent may use it, set by whoever runs the agent, never by the model."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Rules:
    """Arguments of protogrid's gate. The defaults refuse what no agent should load: tools that hide text from people,
    tools holding instructions aimed at the model, servers depending on a package with a known vulnerability, and servers
    that charge per call (x402), which an agent without a wallet cannot use."""

    min_quality: int | None = None
    min_trust: int | None = None
    no_fail: Sequence[str] = ("tools.hidden_text", "tools.poisoning")
    exclude_quality_flags: Sequence[str] = ("known-vulns",)
    exclude_flags: Sequence[str] = ()
    owner_verified: bool | None = None
    #: ``False`` (the default) refuses servers that charge per call (x402), ``True`` accepts only those, ``None`` both.
    paid: bool | None = False
    #: Connection classes allowed (R0 nothing to set up, R1 a key you hold, R2 OAuth sign-in). Local packages (L0)
    #: are never loaded: they would run third-party code on your machine.
    classes: Sequence[str] = field(default=("R0", "R1"))

    def gate_kwargs(self) -> dict[str, Any]:
        return {
            "min_quality": self.min_quality,
            "min_trust": self.min_trust,
            "no_fail": list(self.no_fail) or None,
            "exclude_quality_flags": list(self.exclude_quality_flags) or None,
            "exclude_flags": list(self.exclude_flags) or None,
            "class_": [c for c in self.classes if c != "L0"] or None,
            "owner_verified": self.owner_verified,
            "paid": self.paid,
        }


DEFAULT_RULES = Rules()
