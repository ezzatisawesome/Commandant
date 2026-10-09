import type { Metadata } from "next";
import "./globals.css";
import "cesium/Build/Cesium/Widgets/widgets.css";

export const metadata: Metadata = {
	title: "Commandant",
	description: "Flight/ops visualization for the solar airplane",
	// The shield the wordmark wears, as an SVG that flips with the OS light/dark
	// scheme — a tab is the one place the app is seen on a light background.
	icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body>{children}</body>
		</html>
	);
}
