"use client";

import dynamic from "next/dynamic";
import {
	Shield, Gauge, Eye, ScrollText, Route, Hexagon, Sliders, Plane,
} from "lucide-react";
import { Saira_Condensed } from "next/font/google";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { IS_VIEW } from "@/lib/envs";
import { Dock, type DockItem } from "@/components/flight/Dock";

const saira = Saira_Condensed({ subsets: ["latin"], weight: ["600"] });

// Cesium touches the DOM, so every island is client-only (no SSR) — the Next
// equivalent of Astro's client:only="react".
const Globe = dynamic(() => import("@/components/Globe"), { ssr: false });
const Aircraft = dynamic(() => import("@/components/flight/Aircraft"), { ssr: false });
const InstrumentPanel = dynamic(() => import("@/components/flight/InstrumentPanel"), { ssr: false });
const HeadsUpInstruments = dynamic(() => import("@/components/flight/HeadsUpInstruments"), { ssr: false });
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

const ICON = "h-4 w-4";

// Screen budget, deliberately: the globe keeps everything except four edges.
//
//   top-left     wordmark and the read-only badge, one line
//   top-right    attitude and heading, drawn bare, no panel
//   right edge   a 36 px dock; one panel at a time, opening inboard
//   bottom edge  the telemetry strip
//
// Nothing is pinned to the left edge, and nothing but those two instruments is
// permanently on screen. Panels that used to stack down the right side are now
// dock entries, which is the difference between a map with chrome around it and
// a dashboard with a map in the corner.
export default function FlightPage() {
	const items: DockItem[] = [
		{ key: "inst", label: "Instruments and health", icon: <Gauge className={ICON} />, panel: <ErrorBoundary name="Instruments"><InstrumentPanel /></ErrorBoundary> },
		{ key: "view", label: "View and overlays", icon: <Eye className={ICON} />, panel: <ErrorBoundary name="View controls"><ViewControls /></ErrorBoundary> },
		{ key: "log", label: "Status log", icon: <ScrollText className={ICON} />, panel: <ErrorBoundary name="Status log"><StatusLog /></ErrorBoundary> },
		// Authoring and parameter writing are cockpit-only. The globe still draws
		// the mission and fence the vehicle is actually flying.
		...(IS_VIEW ? [] : [
			{ key: "mission", label: "Mission", icon: <Route className={ICON} />, panel: <ErrorBoundary name="Mission"><MissionPanel /></ErrorBoundary> },
			{ key: "fence", label: "Geofence and rally", icon: <Hexagon className={ICON} />, panel: <ErrorBoundary name="Geofence"><GeoPanel /></ErrorBoundary> },
			{ key: "params", label: "Parameters", icon: <Sliders className={ICON} />, panel: <ErrorBoundary name="Parameters"><ParamEditor /></ErrorBoundary> },
			{ key: "airframe", label: "Airframe", icon: <Plane className={ICON} />, panel: <ErrorBoundary name="Airframe"><AirframeConfig /></ErrorBoundary> },
		]),
	];

	return (
		<>
			<Globe />
			<Aircraft />
			<MissionLayer />
			<GeoLayer />
			<SituationLayer />

			{/* Telemetry readout: a band over the bottom edge of the globe. */}
			<ErrorBoundary name="Telemetry strip"><TelemetryStrip /></ErrorBoundary>

			{/* Wordmark. One line, top-left, nothing beneath it. */}
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

			{/* The only always-on instruments. */}
			<div className="fixed top-3 right-14 z-40">
				<ErrorBoundary name="Heads-up instruments"><HeadsUpInstruments /></ErrorBoundary>
			</div>

			<Dock items={items} />
		</>
	);
}
