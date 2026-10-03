"""Commandant ground-station daemon.

A standalone, long-lived pymavlink process that owns the MAVLink link to PX4
(SITL now, real radio later), runs the command-authority and protocol state
machines (arm/mode, params, missions), and exposes a thin WS/HTTP contract to the
console UI. Deliberately NOT inside the Next.js server — a hot-reloading web
framework must never own arm/disarm or a mission upload.

See ../../docs/roadmap.md for the phased plan.
"""

__version__ = "0.1.0"
