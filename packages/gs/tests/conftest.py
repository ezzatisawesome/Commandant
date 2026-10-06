"""Shared test plumbing: unique free ports per test so files never collide."""

from __future__ import annotations

import socket

import pytest


def _free_port(kind: int) -> int:
    with socket.socket(socket.AF_INET, kind) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def ports() -> dict[str, int]:
    """Fresh OS-assigned ports: `mav` (UDP in), `json` (UDP in), `ws` (TCP)."""
    return {
        "mav": _free_port(socket.SOCK_DGRAM),
        "json": _free_port(socket.SOCK_DGRAM),
        "ws": _free_port(socket.SOCK_STREAM),
    }
