"""`python -m relay` — run the public view-only relay."""

from __future__ import annotations

from .server import main

if __name__ == "__main__":
    raise SystemExit(main())
