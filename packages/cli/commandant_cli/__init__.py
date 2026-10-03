"""Commandant CLI — the single interface to the Raspberry Pi hub.

The hub is both the ground station and the base station: it runs the `gs` daemon
(owning the plane's radio link) and serves the `console` web app, while being its
own standalone WiFi AP reachable at `commandant.local`. This CLI owns that whole
lifecycle — provisioning a fresh Pi, updating it, and starting/stopping/inspecting
the services — modeled on Guppi's CLI.
"""

__version__ = "0.1.0"
