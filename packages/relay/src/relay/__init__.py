"""Commandant relay — the public view-only window onto a live flight.

The field hub cannot be reached inbound (field WiFi, hotspot, CGNAT), and must
never be: command authority lives on the hub and nowhere else. So the hub dials
OUT to this service and pushes frames; browsers connect here and read them.

    hub (gs --relay) ──wss, publish──► relay ──wss, subscribe──► browsers

Read-only by construction, not by configuration: a viewer socket's inbound
messages are discarded without ever being parsed, and the publisher socket is
never read from. There is no code path from a browser to the aircraft.
"""

__all__ = ["Relay"]

from .server import Relay
