"use client";

import dynamic from "next/dynamic";

const Globe = dynamic(() => import("@/components/Globe"), { ssr: false });
const SatelliteLayer = dynamic(() => import("@/components/satellites/SatelliteLayer"), { ssr: false });
const SatInterface = dynamic(() => import("@/components/satellites/SatInterface"), { ssr: false });
const TimeInterface = dynamic(() => import("@/components/TimeInterface"), { ssr: false });

export default function SatellitesPage() {
	return (
		<>
			<Globe />
			<SatelliteLayer />
			<SatInterface />
			<TimeInterface />
		</>
	);
}
