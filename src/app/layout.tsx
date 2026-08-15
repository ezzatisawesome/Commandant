import type { Metadata } from "next";
import "./globals.css";
import "cesium/Build/Cesium/Widgets/widgets.css";

export const metadata: Metadata = {
	title: "Commandant",
	description: "Flight/ops visualization for the solar airplane",
	icons: { icon: "/power.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body>{children}</body>
		</html>
	);
}
