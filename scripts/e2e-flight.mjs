// Real browser test: load /flight in Chromium, feed synthetic telemetry into the
// bridge (udp:14555), and verify the plane renders and the Track button moves the
// camera to it. Assumes `npm run dev` is already running on :3000.
import { chromium } from "playwright";
import { createSocket } from "node:dgram";

const sock = createSocket("udp4");
let lat = 37.4275, lon = -122.1697; // Stanford campus
const timer = setInterval(() => {
	lat += 0.00002;
	lon += 0.00002;
	const frame = {
		t: Date.now(), lat, lon, alt: 1200,
		roll: 0.1, pitch: 0.05, yaw: 1.2,
		heading: 68, airspeed: 12, throttle: 20, batteryRemaining: 100,
	};
	sock.send(Buffer.from(JSON.stringify(frame)), 14555, "127.0.0.1");
}, 50);

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto("http://localhost:3000/flight", { waitUntil: "networkidle" });
await page.waitForTimeout(4000); // let Cesium init + telemetry arrive

// 1) Did the page throw?
console.log("errors on load:", errors.length ? errors : "none");

// 2) Is the viewer up and is there an aircraft entity?
const info = await page.evaluate(() => {
	const v = window.__cesiumViewer;
	if (!v) return { viewer: false };
	const ents = v.entities.values;
	return {
		viewer: true,
		entityCount: ents.length,
		hasPoint: ents.some((e) => !!e.point),
		camHeight: v.camera.positionCartographic.height,
	};
});
console.log("viewer/entities:", info);

// 3) HUD populated (telemetry reached the store)?
const airspeed = await page.textContent("body");
const hudLive = /Airspeed/.test(airspeed || "");
console.log("HUD present:", hudLive);

// 4) Track button state + click, then check camera moved toward the plane.
const btn = page.getByRole("button", { name: /track aircraft/i });
const disabled = await btn.isDisabled();
console.log("Track button disabled:", disabled);

const before = await page.evaluate(() => {
	const c = window.__cesiumViewer.camera.positionCartographic;
	return { lat: (c.latitude * 180) / Math.PI, lon: (c.longitude * 180) / Math.PI, h: c.height };
});
await btn.click();
await page.waitForTimeout(2500); // flyTo ~1.2s + settle
const after = await page.evaluate(() => {
	const c = window.__cesiumViewer.camera.positionCartographic;
	return { lat: (c.latitude * 180) / Math.PI, lon: (c.longitude * 180) / Math.PI, h: c.height };
});
console.log("camera before:", before);
console.log("camera after :", after);

const movedToPlane = Math.abs(after.lat - 37.4275) < 0.2 && Math.abs(after.lon - -122.1697) < 0.2;
const zoomedIn = after.h < before.h * 0.5;
console.log("camera moved to plane:", movedToPlane, "| zoomed in:", zoomedIn);

const pass =
	errors.length === 0 && info.viewer && info.entityCount >= 1 &&
	!disabled && movedToPlane;
console.log(pass ? "\n✅ PASS" : "\n❌ FAIL");

clearInterval(timer);
sock.close();
await browser.close();
process.exit(pass ? 0 : 1);
