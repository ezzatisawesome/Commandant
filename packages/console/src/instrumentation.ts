// Next calls register() once on server startup.
//
// The telemetry bridge used to run in-process here (UDP MAVLink/JSON -> WS). It
// now lives in the standalone `gs` daemon (packages/gs) so a hot-reloading web
// framework never owns the link or, later, arm/disarm and mission uploads. Run
// it alongside the console:  cd packages/gs && python -m gs
//
// The console connects to gs over WebSocket (ws://localhost:8790) exactly as
// before (see services/telemetry.ts); nothing to start here.
export async function register() {}
