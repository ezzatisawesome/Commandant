"use client";

import dynamic from "next/dynamic";
import { Plane } from "lucide-react";

// Cesium touches the DOM, so every island is client-only (no SSR) — the Next
// equivalent of Astro's client:only="react".
const Globe = dynamic(() => import("@/components/Globe"), { ssr: false });
const Aircraft = dynamic(() => import("@/components/flight/Aircraft"), { ssr: false });
const FlightHUD = dynamic(() => import("@/components/flight/FlightHUD"), { ssr: false });
const AirframeConfig = dynamic(() => import("@/components/flight/AirframeConfig"), { ssr: false });
const TimeInterface = dynamic(() => import("@/components/TimeInterface"), { ssr: false });

export default function FlightPage() {
	return (
		<>
			<Globe />
			<Aircraft />

			{/* Branding */}
			<div className="fixed top-4 left-4 z-50 flex items-center gap-2">
				<Plane className="h-5 w-5 text-white" />
				<span className="text-sm font-semibold tracking-wide text-white">Commandant</span>
			</div>

			{/* Right rail: HUD with the airframe config stacked underneath it. */}
			<div className="fixed top-4 right-4 z-50 flex flex-col items-end gap-2">
				<FlightHUD />
				<AirframeConfig />
			</div>

			<TimeInterface />
		</>
	);
}
