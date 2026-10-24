import type { Metadata, Viewport } from "next";
import "./globals.css";
import "cesium/Build/Cesium/Widgets/widgets.css";

export const metadata: Metadata = {
	title: "Commandant",
	description: "Flight/ops visualization for the solar airplane",
	// The shield the wordmark wears, as an SVG that flips with the OS light/dark
	// scheme — a tab is the one place the app is seen on a light background.
	icons: { icon: "/favicon.svg" },
};

// A ground station is read on a phone in the field as often as on a desk, and
// without this the browser laid the console out at 980 px and scaled it down:
// every instrument half-legible, every touch target half-size.
//
// `maximumScale: 1` is normally an accessibility sin — it takes away pinch-to-
// zoom. Here the whole page is a map: pinch IS the globe's zoom gesture, and a
// browser that intercepts it to scale the document instead leaves the operator
// pinching at a picture of the console. The text that matters is sized for
// reading rather than scaled down, which is the obligation that rule exists to
// protect. Same reasoning for `interactiveWidget`: a keyboard opening must not
// resize the globe underneath it.
//
// `viewportFit: "cover"` lets the globe run under the notch and the home bar;
// the chrome that must stay clear of them uses the safe-area insets (globals.css).
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
	viewportFit: "cover",
	interactiveWidget: "resizes-content",
	themeColor: "#000000",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body>{children}</body>
		</html>
	);
}
