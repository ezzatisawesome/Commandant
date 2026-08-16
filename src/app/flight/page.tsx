"use client";

import dynamic from "next/dynamic";
import { Shield } from "lucide-react";
import { Saira_Condensed } from "next/font/google";

const saira = Saira_Condensed({ subsets: ["latin"], weight: ["600"] });

// Cesium touches the DOM, so every island is client-only (no SSR) — the Next
// equivalent of Astro's client:only="react".
const Globe = dynamic(() => import("@/components/Globe"), { ssr: false });
const Aircraft = dynamic(() => import("@/components/flight/Aircraft"), { ssr: false });
const FlightHUD = dynamic(() => import("@/components/flight/FlightHUD"), { ssr: false });
const AirframeConfig = dynamic(() => import("@/components/flight/AirframeConfig"), { ssr: false });

export default function FlightPage() {
	return (
		<>
			<Globe />
			<Aircraft />

			{/* Branding */}
			<div className="fixed top-4 left-4 z-50 flex items-center gap-2">
				<Shield className="h-[22px] w-[22px] text-white" />
				<span className={`${saira.className} text-lg font-semibold uppercase tracking-wide text-white`}>
					Commandant
				</span>
			</div>

			{/* Right rail: HUD with the airframe config stacked underneath it. */}
			<div className="fixed top-4 right-4 z-50 flex flex-col items-end gap-2">
				<FlightHUD />
				<AirframeConfig />
			</div>
		</>
	);
}
