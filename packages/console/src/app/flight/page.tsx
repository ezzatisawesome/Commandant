"use client";

import dynamic from "next/dynamic";
import { Shield } from "lucide-react";
import { Saira_Condensed } from "next/font/google";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { IS_VIEW } from "@/lib/envs";

const saira = Saira_Condensed({ subsets: ["latin"], weight: ["600"] });

// Cesium touches the DOM, so every island is client-only (no SSR) — the Next
// equivalent of Astro's client:only="react".
const Globe = dynamic(() => import("@/components/Globe"), { ssr: false });
const Aircraft = dynamic(() => import("@/components/flight/Aircraft"), { ssr: false });
const FlightHUD = dynamic(() => import("@/components/flight/FlightHUD"), { ssr: false });
const ViewControls = dynamic(() => import("@/components/flight/ViewControls"), { ssr: false });
const AirframeConfig = dynamic(() => import("@/components/flight/AirframeConfig"), { ssr: false });
const ParamEditor = dynamic(() => import("@/components/flight/ParamEditor"), { ssr: false });
const MissionLayer = dynamic(() => import("@/components/flight/MissionLayer"), { ssr: false });
const MissionPanel = dynamic(() => import("@/components/flight/MissionPanel"), { ssr: false });
const GeoLayer = dynamic(() => import("@/components/flight/GeoLayer"), { ssr: false });
const GeoPanel = dynamic(() => import("@/components/flight/GeoPanel"), { ssr: false });
const StatusLog = dynamic(() => import("@/components/flight/StatusLog").then((m) => m.StatusLog), { ssr: false });

export default function FlightPage() {
	return (
		<>
			<Globe />
			<Aircraft />
			<MissionLayer />
			<GeoLayer />

			{/* Branding */}
			<div className="fixed top-4 left-4 z-50 flex items-center gap-2">
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

			{/* Right rail: HUD, status log, view controls, params, airframe config. */}
			<div className="fixed top-4 right-4 z-50 flex max-h-[calc(100vh-2rem)] flex-col items-end gap-2 overflow-y-auto">
				<ErrorBoundary name="Telemetry"><FlightHUD /></ErrorBoundary>
				<ErrorBoundary name="Status log"><StatusLog /></ErrorBoundary>
				<ErrorBoundary name="View controls"><ViewControls /></ErrorBoundary>
				{/* Authoring and parameter writing are cockpit-only. The globe still
				    draws the mission and fence the vehicle is actually flying. */}
				{IS_VIEW ? null : (
					<>
						<ErrorBoundary name="Mission"><MissionPanel /></ErrorBoundary>
						<ErrorBoundary name="Geofence"><GeoPanel /></ErrorBoundary>
						<ErrorBoundary name="Parameters"><ParamEditor /></ErrorBoundary>
						<ErrorBoundary name="Airframe"><AirframeConfig /></ErrorBoundary>
					</>
				)}
			</div>
		</>
	);
}
