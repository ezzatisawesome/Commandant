"use client";

import dynamic from "next/dynamic";
import { Shield, Terminal, Eye, ScrollText, Route, Sliders } from "lucide-react";
import { Saira_Condensed } from "next/font/google";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { IS_VIEW } from "@/lib/envs";
import { Dock, type DockItem } from "@/components/flight/Dock";
import { PanelTabs } from "@/components/flight/PanelTabs";

const saira = Saira_Condensed({ subsets: ["latin"], weight: ["600"] });

// Cesium touches the DOM, so every island is client-only (no SSR) — the Next
// equivalent of Astro's client:only="react".
const Globe = dynamic(() => import("@/components/Globe"), { ssr: false });
const Aircraft = dynamic(() => import("@/components/flight/Aircraft"), { ssr: false });
const CommandsPanel = dynamic(() => import("@/components/flight/CommandsPanel"), { ssr: false });
const Hud = dynamic(() => import("@/components/flight/Hud"), { ssr: false });
const Alerts = dynamic(() => import("@/components/flight/Alerts"), { ssr: false });
const TelemetryStrip = dynamic(() => import("@/components/flight/TelemetryStrip").then((m) => m.TelemetryStrip), { ssr: false });
const ViewControls = dynamic(() => import("@/components/flight/ViewControls"), { ssr: false });
const AirframeConfig = dynamic(() => import("@/components/flight/AirframeConfig"), { ssr: false });
const ParamEditor = dynamic(() => import("@/components/flight/ParamEditor"), { ssr: false });
const MissionLayer = dynamic(() => import("@/components/flight/MissionLayer"), { ssr: false });
const MissionPanel = dynamic(() => import("@/components/flight/MissionPanel"), { ssr: false });
const GeoLayer = dynamic(() => import("@/components/flight/GeoLayer"), { ssr: false });
const SituationLayer = dynamic(() => import("@/components/flight/SituationLayer"), { ssr: false });
const GeoPanel = dynamic(() => import("@/components/flight/GeoPanel"), { ssr: false });
const StatusLog = dynamic(() => import("@/components/flight/StatusLog").then((m) => m.StatusLog), { ssr: false });
const LogFeed = dynamic(() => import("@/components/flight/LogFeed").then((m) => m.LogFeed), { ssr: false });

const ICON = "h-4 w-4";

// Screen budget, deliberately: the globe keeps everything except four edges.
//
//   everywhere   the HUD: horizon, pitch ladder, bank scale, flight path
//                marker, heading tape on top, airspeed and altitude tapes down
//                the sides. Strokes over the globe, fixed to the screen, and
//                transparent to the mouse, so it costs no area at all.
//   top-left     wordmark and the read-only badge, one line, with the last few
//                autopilot status lines tailing beneath it in green
//   top-centre   transient alerts, warning severity and worse only
//   right edge   a 36 px dock; five icons, one panel at a time, opening inboard
//   bottom edge  the telemetry strip, full width, with vehicle health pinned
//                to its header line
//
// Nothing is pinned to the left edge, and no instrument sits in a box any more.
// Panels that used to stack down the right side are dock entries, which is the
// difference between a map with chrome around it and a dashboard with a map in
// the corner.
export default function FlightPage() {
	// Five icons, down from seven. The gutter is permanent screen real estate, so
	// an icon has to earn its slot: health moved out of the dock onto the
	// telemetry strip (always visible, no click), and the pairs that do the same
	// job — mission/geofence, parameters/airframe — share one icon with tabs,
	// since the dock only ever shows one panel anyway.
	const items: DockItem[] = [
		{ key: "cmd", label: "Commands", icon: <Terminal className={ICON} />, panel: <ErrorBoundary name="Commands"><CommandsPanel /></ErrorBoundary> },
		// Authoring and parameter writing are cockpit-only. The globe still draws
		// the mission and fence the vehicle is actually flying.
		...(IS_VIEW ? [] : [
			{
				key: "mission", label: "Mission and geofence", icon: <Route className={ICON} />,
				panel: (
					<PanelTabs tabs={[
						{ key: "wp", label: "Waypoints", content: <ErrorBoundary name="Mission"><MissionPanel /></ErrorBoundary> },
						{ key: "fence", label: "Fence / rally", content: <ErrorBoundary name="Geofence"><GeoPanel /></ErrorBoundary> },
					]} />
				),
			},
			{
				key: "config", label: "Vehicle configuration", icon: <Sliders className={ICON} />,
				panel: (
					<PanelTabs tabs={[
						{ key: "params", label: "Parameters", content: <ErrorBoundary name="Parameters"><ParamEditor /></ErrorBoundary> },
						{ key: "airframe", label: "Airframe", content: <ErrorBoundary name="Airframe"><AirframeConfig /></ErrorBoundary> },
					]} />
				),
			},
		]),
		{ key: "view", label: "View and overlays", icon: <Eye className={ICON} />, panel: <ErrorBoundary name="View controls"><ViewControls /></ErrorBoundary> },
		{ key: "log", label: "Status log", icon: <ScrollText className={ICON} />, panel: <ErrorBoundary name="Status log"><StatusLog /></ErrorBoundary> },
	];

	return (
		<>
			<Globe />
			<Aircraft />
			<MissionLayer />
			<GeoLayer />
			<SituationLayer />

			{/* The HUD sits above the globe and below the chrome. */}
			<ErrorBoundary name="HUD"><Hud /></ErrorBoundary>

			{/* Telemetry readout: a band over the bottom edge of the globe. */}
			<ErrorBoundary name="Telemetry strip"><TelemetryStrip /></ErrorBoundary>

			{/* The autopilot's own words, tailing down the top-left under the
			    wordmark. Read-only and transparent to the mouse: the dock's Status
			    panel is still the full record. */}
			<ErrorBoundary name="Log feed"><LogFeed /></ErrorBoundary>

			{/* Wordmark. One line, top-left, the log feed beneath it. */}
			<div className="pointer-events-none fixed top-4 left-4 z-50 flex items-center gap-2">
				<Shield className="h-[22px] w-[22px] text-white" />
				<span className={`${saira.className} text-lg font-semibold uppercase tracking-wide text-white`}>
					Commandant
				</span>
				{IS_VIEW ? (
					<span
						className="rounded border border-sky-400/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300"
						title="Read-only view of a live flight. Commanding happens only on the ground-station hub."
					>
						watching
					</span>
				) : null}
			</div>

			{/* Autopilot warnings and failsafes, in front of everything. The
			    status log keeps the full record; this is what interrupts. */}
			<ErrorBoundary name="Alerts"><Alerts /></ErrorBoundary>

			<Dock items={items} />
		</>
	);
}
