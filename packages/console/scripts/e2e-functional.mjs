// Does the platform actually work, in a browser, against the real daemon?
//
// The unit suites cover stores and pure functions; not one of them renders a
// component. So "is the UI functional" was a question nothing in this repo
// could answer, and neither could "does a mission round-trip through the UI",
// because every mission test stops at the store or at gs's socket.
//
// This drives real Chromium through the operator's own sequence against a real
// gs and the stand-in autopilot: ingest telemetry, read the vehicle's plan back,
// author a waypoint by clicking the globe, upload it, do the same for a
// geofence, then arm and run the mission from the command bar. It asserts and
// exits nonzero, so it can gate a release.
//
//   node scripts/e2e-functional.mjs            # starts everything itself
//   HEADED=1 node scripts/e2e-functional.mjs   # watch it
//
// What it is NOT: a test against real PX4. The autopilot is the stand-in, which
// is deliberately indistinguishable from SITL/HITL/the airframe on the wire --
// but the browser, the console build, gs and the whole protocol path are real.

import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, "..");
const GS_DIR = path.resolve(HERE, "../../gs");
const WS_PORT = 8790;

const steps = [];
let page;

function step(name, ok, note = "") {
	steps.push({ name, ok, note });
	const mark = ok ? "ok  " : "FAIL";
	console.log(`  ${mark} ${name.padEnd(46)} ${note}`);
	return ok;
}

async function check(name, fn, note = () => "") {
	try {
		const v = await fn();
		return step(name, Boolean(v), note(v));
	} catch (e) {
		return step(name, false, String(e.message || e).slice(0, 70));
	}
}

/** The panel's own count, which is DATA the component rendered from the store —
 *  not body text. An earlier version of this test counted /incl/i in the page
 *  and matched GeoPanel's "incl poly" BUTTON LABEL, so "four fence vertices
 *  drawn" passed while nothing had been drawn at all. An assertion that can be
 *  satisfied by the chrome around the data is worse than no assertion. */
// Open the mission/geofence dock panel, or leave it open if it already is.
// The button is a TOGGLE and the panel stays open across sections, so a second
// bare click closes it -- which reads in the DOM exactly like a panel that
// never rendered the thing being asserted. One section-7 failure was that and
// not the app.
async function openMissionPanel() {
	if (await page.getByText(/^Mission \(/).count()) return;
	await page.getByRole("button", { name: /mission and geofence/i }).click();
	await until(() => page.getByText(/^Mission \(/).count().then((n) => n > 0), { timeout: 10000 });
}

async function panelCount(re) {
	const txt = await page.textContent("body");
	const m = txt.match(re);
	return m ? Number(m[1]) : null;
}
const missionCount = () => panelCount(/Mission \((\d+)\)/);
const fenceCount = () => panelCount(/Fence \((\d+)\)/);

/** Poll until `fn` is truthy, so the test waits on the app rather than a sleep. */
async function until(fn, { timeout = 15000, every = 250 } = {}) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeout) return null;
		await new Promise((r) => setTimeout(r, every));
	}
}

async function freePort() {
	const s = createServer();
	s.listen(0);
	await once(s, "listening");
	const { port } = s.address();
	await new Promise((r) => s.close(r));
	return port;
}

const procs = [];
function spawnLogged(label, cmd, args, opts) {
	// Own process group, so teardown can kill the whole tree. `uv run python`
	// and `npx next` are wrappers: killing the wrapper orphans the child, and an
	// orphaned autopilot left on the MAVLink port is what drove the reboot storm
	// in two earlier runs of this very script.
	const p = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	p.stdout.setEncoding("utf8");
	p.stderr.setEncoding("utf8");
	p.lines = [];
	const take = (s) => { p.lines.push(...s.split("\n").filter(Boolean)); };
	p.stdout.on("data", take);
	p.stderr.on("data", take);
	p.on("exit", (code) => { p.exited = code; });
	procs.push({ label, p });
	return p;
}

async function waitForLine(proc, re, timeout = 90000) {
	return until(() => proc.lines.some((l) => re.test(l)), { timeout, every: 200 });
}

function shutdown() {
	for (const { p } of procs) {
		try { process.kill(-p.pid, "SIGKILL"); } catch { /* group gone */ }
		try { p.kill("SIGKILL"); } catch { /* gone */ }
	}
}
process.on("exit", shutdown);
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => { shutdown(); process.exit(1); });
}

// --------------------------------------------------------------------------

/** Nothing else may be holding gs's port.
 *
 *  A previous run that has not exited yet is worse than a port conflict: the new
 *  fixture fails to bind, logs it, and the browser then talks to the STALE
 *  daemon — so the test passes or fails against code that is not the code under
 *  test. The first run of this script did exactly that. */
async function requirePortFree(port, label) {
	const freed = await until(async () => {
		const s = createServer();
		const ok = await new Promise((res) => {
			s.once("error", () => res(false));
			s.once("listening", () => s.close(() => res(true)));
			s.listen(port, "127.0.0.1");
		});
		return ok || null;
	}, { timeout: 15000, every: 500 });
	if (!freed) {
		console.log(`  FAIL ${label} port ${port} is still held by another process.`);
		console.log(`       lsof -ti:${port} | xargs kill   # then re-run`);
		process.exit(1);
	}
}
// Both ports. The MAVLink one is the one that leaked, and the consequence was
// worse than a conflict: the new fixture failed to bind, the browser talked to
// the STALE daemon from the previous run, and the second autopilot left on the
// port drove gs into a reboot storm — which is how that bug was found, but is
// not a thing a test should depend on.
// Kill leftovers from an interrupted run before checking the ports.
//
// `uv run python` and `npx next` are wrappers: a run that was cancelled or timed
// out can leave the Python child alive, and an orphaned stand-in autopilot still
// streaming at sysid 1 makes gs see TWO clocks on one sysid — which it now
// reports as a shared sysid (correctly), after which the console's view of the
// vehicle's mission is cleared and several checks below fail for a reason that
// has nothing to do with the code. Three runs of this script were debugged
// against that before the pattern was clear, so it is worth doing here rather
// than leaving to whoever runs it next.
try {
	const { execFileSync } = await import("node:child_process");
	execFileSync("pkill", ["-f", "e2e_fixture.py"], { stdio: "ignore" });
} catch { /* nothing to kill */ }
await new Promise((r) => setTimeout(r, 1500));

await requirePortFree(WS_PORT, "gs websocket");
await requirePortFree(14550, "gs mavlink");

const webPort = await freePort();
console.log("\nCommandant end-to-end — real browser, real daemon, stand-in autopilot\n");
console.log(" bringing it up");

const gs = spawnLogged("gs", "uv",
	["run", "python", "-u", "scripts/e2e_fixture.py", "--ws-port", String(WS_PORT)],
	{ cwd: GS_DIR });
if (!await waitForLine(gs, /^READY$/, 40000)) {
	console.log("  FAIL gs fixture never reported a vehicle");
	console.log(gs.lines.slice(-12).map((l) => "      " + l).join("\n"));
    shutdown();
	process.exit(1);
}
step("gs up, locked onto the vehicle", true, `ws://localhost:${WS_PORT}`);

const web = spawnLogged("next", "npx",
	["next", "start", "-p", String(webPort)],
	{ cwd: CONSOLE_DIR, env: { ...process.env,
		NEXT_PUBLIC_MAVLINK_WS_ENDPOINT: `ws://localhost:${WS_PORT}` } });
if (!await waitForLine(web, /Ready in|started server|Local:/i, 60000)) {
	console.log("  FAIL the console server never started");
	console.log(web.lines.slice(-12).map((l) => "      " + l).join("\n"));
	shutdown();
	process.exit(1);
}
step("console served (production build)", true, `http://localhost:${webPort}`);

// Playwright's bundled-browser version can run ahead of what is cached, and
// downloading one is not always possible (no network, a locked-down machine).
// Any reasonably recent Chromium drives this app, so fall back to whatever is
// cached rather than making the test unrunnable over a version number —
// CHROMIUM overrides it outright.
async function launchChromium() {
	const headless = !process.env.HEADED;
	try {
		return await chromium.launch({ headless, executablePath: process.env.CHROMIUM });
	} catch (e) {
		if (process.env.CHROMIUM) throw e;
		const { globSync } = await import("node:fs");
		const home = process.env.HOME;
		const cached = globSync([
			`${home}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell`,
			`${home}/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
			`${home}/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/chrome`,
			`${home}/.cache/ms-playwright/chromium-*/chrome-linux/chrome`,
		]).sort();
		if (!cached.length) throw e;
		const executablePath = cached[cached.length - 1];
		console.log(`  note: using the cached browser at ${executablePath.replace(home, "~")}`);
		return await chromium.launch({ headless, executablePath });
	}
}

const browser = await launchChromium();
page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
// Name the resource. "Failed to load resource: 404" without the URL is a
// finding nobody can act on.
page.on("requestfailed", (r) => pageErrors.push(`requestfailed ${r.url()}`));
page.on("response", (r) => { if (r.status() >= 400) pageErrors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(`http://localhost:${webPort}/flight`, { waitUntil: "domcontentloaded" });

// --- 1. does the UI come up at all? ---------------------------------------
console.log("\n ingestion and the UI");

await check("the page renders without throwing",
	async () => {
		await until(() => page.evaluate(() => Boolean(window.__cesiumViewer)), { timeout: 40000 });
		return pageErrors.length === 0;
	},
	() => (pageErrors.length ? pageErrors.slice(0, 2).join(" | ") : "no page errors"));

await check("Cesium viewer initialised, aircraft drawn",
	() => page.evaluate(() => {
		const v = window.__cesiumViewer;
		if (!v) return null;
		return v.entities.values.length >= 1 ? v.entities.values.length : null;
	}),
	(n) => `${n} entities`);

// Data ingestion: these numbers came off MAVLink, through gs, over the socket,
// into the store, onto the screen. Reading them from the DOM is the only check
// that covers the whole path.
await check("live telemetry reaches the HUD",
	() => until(async () => {
		const txt = await page.textContent("body");
		return /AUTO\.MISSION|MANUAL/.test(txt) && /Airspeed/i.test(txt) ? txt : null;
	}, { timeout: 25000 }),
	() => "mode and instruments on screen");

await check("the link reads alive, not connecting",
	() => until(() => page.evaluate(() => {
		const f = window.__cesiumViewer && document.body.innerText;
		return f && !/connecting/i.test(f.slice(0, 400));
	}), { timeout: 20000 }),
	() => "link indicator settled");

// --- 2. mission planning, through the panels ------------------------------
console.log("\n mission planning");

await check("the mission panel opens from the dock", async () => {
	await openMissionPanel();
	return await until(async () => (await missionCount()) !== null
		|| /not read from the vehicle yet/i.test(await page.textContent("body")),
	{ timeout: 10000 });
}, () => "mission panel rendered");

await check("an unread plan says so rather than claiming none", async () => {
	const txt = await page.textContent("body");
	return /not read from the vehicle yet/i.test(txt);
}, () => "'not read from the vehicle yet'");

await check("Download reads the vehicle's plan", async () => {
	await page.getByRole("button", { name: /^Download$/ }).first().click();
	return await until(async () => {
		const txt = await page.textContent("body");
		return /no mission on the vehicle/i.test(txt) ? "read back: empty" : null;
	}, { timeout: 15000 });
}, (v) => v || "");

await check("clicking the globe in edit mode adds a waypoint", async () => {
	await page.getByRole("button", { name: /^Edit map$/ }).click();
	const box = await page.locator("canvas").first().boundingBox();
	// Three clicks away from the centre, where the aircraft and its UI chrome sit.
	for (const [dx, dy] of [[-120, -80], [40, -60], [140, 30]]) {
		await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
		await page.waitForTimeout(400);
	}
	return await until(async () => {
		const n = await missionCount();
		return n !== null && n >= 3 ? n : null;
	}, { timeout: 8000 });
}, (n) => `the panel counts ${n} items`);

await check("Upload is offered once there is a plan and authority", async () => {
	const up = page.getByRole("button", { name: /^Upload$|^Uploading/ }).first();
	return !(await up.isDisabled());
}, () => "Upload enabled");

await check("Upload round-trips to the vehicle", async () => {
	await page.getByRole("button", { name: /^Upload$/ }).first().click();
	return await until(async () => {
		const txt = await page.textContent("body");
		if (/rejected|timeout|busy/i.test(txt)) return null;
		return /accepted|uploaded/i.test(txt) ? "accepted" : null;
	}, { timeout: 25000 });
}, (v) => v || "");

await check("after upload the draft matches the vehicle", async () => {
	// The divergence warning must be ABSENT now: the upload is the moment the
	// two provably agree, and a warning here would mean the console does not
	// believe its own successful upload.
	const txt = await page.textContent("body");
	return !/edited since the vehicle last took it/i.test(txt);
}, () => "no stale-draft warning");

await check("a re-Download returns the uploaded plan, not an empty one", async () => {
	// Clear the draft first, so a readback is the ONLY thing that can put items
	// back. Comparing against a draft that is already right proves nothing.
	const before = await missionCount();
	await page.getByRole("button", { name: /^Clear$|^Clear plan$/ }).first().click()
		.catch(() => {});
	await page.getByRole("button", { name: /^Download$/ }).first().click();
	return await until(async () => {
		const n = await missionCount();
		return n !== null && n >= 3 ? `${n} of ${before} came back` : null;
	}, { timeout: 20000 });
}, (v) => v || "");

// --- 3. the geofence ------------------------------------------------------
console.log("\n geofence");

await check("the fence tab opens", async () => {
	await page.getByRole("tab", { name: /fence/i }).or(
		page.getByRole("button", { name: /fence \/ rally/i })).first().click();
	return await until(() => page.textContent("body")
		.then((t) => /no fence|not read from the vehicle/i.test(t)), { timeout: 8000 });
}, () => "fence panel visible");

await check("an undrawn fence does not claim the vehicle has none", async () => {
	const txt = await page.textContent("body");
	return /not read from the vehicle yet/i.test(txt);
}, () => "'not read from the vehicle yet'");

await check("drawing fence vertices on the globe", async () => {
	// The geofence panel has its OWN edit toggle ($geoEdit), separate from the
	// mission's: turning on "Edit map" in one does not place vertices in the
	// other, which is exactly what made the first version of this test think it
	// had drawn a fence when it had not.
	const edit = page.getByRole("button", { name: /^Edit map$|^Editing map$/ }).first();
	if (/^Edit map$/.test(((await edit.textContent()) || "").trim())) await edit.click();
	const box = await page.locator("canvas").first().boundingBox();
	const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
	for (const [dx, dy] of [[-200, -150], [200, -150], [200, 150], [-200, 150]]) {
		await page.mouse.click(cx + dx, cy + dy);
		await page.waitForTimeout(350);
	}
	return await until(async () => {
		const n = await fenceCount();
		return n !== null && n >= 3 ? n : null;
	}, { timeout: 8000 });
}, (n) => `the panel counts ${n} vertices`);

await check("a 3+ vertex polygon is accepted for upload (not refused as degenerate)",
	async () => {
		// Only the active tab's content is mounted, so there is one Upload.
		const up = page.getByRole("button", { name: /^Upload$/ }).first();
		return !(await up.isDisabled());
	}, () => "Upload enabled");

await check("the fence uploads and the vehicle takes it", async () => {
	const up = page.getByRole("button", { name: /^Upload$/ }).first();
	if (await up.isDisabled()) {
		const why = await up.getAttribute("title");
		throw new Error(`Upload disabled: ${why}`);
	}
	await up.click();
	return await until(async () => {
		const txt = await page.textContent("body");
		if (/rejected|timeout|vert/i.test(txt) && !/accepted/i.test(txt)) return null;
		return /accepted/i.test(txt) ? "accepted" : null;
	}, { timeout: 25000 });
}, (v) => v || "");

await check("the fence reads back from the vehicle with its vertex count",
	async () => {
		// Clear the draft first, so only a readback can repopulate it — the point
		// is that the VEHICLE has the fence, and gs derived each vertex's count
		// (H13) rather than taking it from the client.
		await page.getByRole("button", { name: /^Clear$/ }).first().click().catch(() => {});
		await until(async () => (await fenceCount()) === 0, { timeout: 5000 });
		await page.getByRole("button", { name: /^Download$/ }).first().click();
		return await until(async () => {
			const c = await fenceCount();
			return c !== null && c >= 3 ? c : null;
		}, { timeout: 20000 });
	}, (c) => `${c} vertices came back`);

// --- 4. mission execution -------------------------------------------------
console.log("\n mission execution");

await check("the commands panel opens", async () => {
	// Arm and the mode buttons live in CommandBar, inside the Commands panel.
	// The first version of this test clicked for them while the mission panel
	// was open and timed out on a button that was not on screen.
	await page.getByRole("button", { name: /^Commands$/i }).click();
	return await until(() => page.getByRole("button", { name: /^Arm$|^Disarm$/ })
		.first().isVisible().catch(() => false), { timeout: 10000 });
}, () => "Arm and the mode buttons on screen");

await check("Arm is offered and the vehicle arms", async () => {
	await page.getByRole("button", { name: "Arm", exact: true }).first().click();
	return await until(async () => {
		const txt = await page.textContent("body");
		return /ARMED|Disarm/.test(txt) ? "armed" : null;
	}, { timeout: 20000 });
}, (v) => v || "");

await check("MISSION switches the vehicle into AUTO.MISSION", async () => {
	// Not an exact name: the button carries a warning marker when the plan PX4
	// holds is unknown or would be refused, so its accessible name is
	// "MISSION ▲". Matching exactly found nothing and the truncated diagnostic
	// made it look like the panel had closed — it had not.
	const btn = page.getByRole("button", { name: /^MISSION/ }).first();
	if (!(await btn.isVisible())) {
		const names = await page.getByRole("button").allTextContents();
		throw new Error(`no MISSION button; buttons: ${names.filter(Boolean).join(" | ")}`);
	}
	// The bar disables every control while a command is in flight (`busy`), and
	// Arm's ack can land after the vehicle's own ARMED telemetry — so clicking
	// the instant the HUD says ARMED races the previous command, not the app.
	if (!await until(() => btn.isEnabled(), { timeout: 15000 })) {
		throw new Error(`MISSION still disabled: ${await btn.getAttribute("title")}`);
	}
	await btn.click();
	return await until(async () => {
		const txt = await page.textContent("body");
		return /AUTO\.MISSION/.test(txt) ? "AUTO.MISSION" : null;
	}, { timeout: 20000 });
}, (v) => v || "");

await check("MISSION stops warning once the vehicle's plan is known", async () => {
	// The marker on that button means "the plan PX4 holds is unknown, or it
	// would refuse it". By now a plan has been uploaded and read back, so it
	// must be gone — a warning that never clears is one the operator learns to
	// ignore.
	const name = await page.getByRole("button", { name: /^MISSION/ }).first().textContent();
	return !/▲/.test(name || "") ? "no warning marker" : null;
}, (v) => v || "still marked ▲");

await check("execution progress reaches the UI", async () => {
	// MISSION_CURRENT / MISSION_ITEM_REACHED from the vehicle, which only arrive
	// once it is armed and flying the plan.
	return await until(() => page.evaluate(() => {
		const v = window.__cesiumViewer;
		if (!v) return null;
		// The current item is drawn yellow; any yellow point means execution
		// state is being applied to a plan the console believes matches.
		return v.entities.values.some((e) => {
			const c = e.point && e.point.color && e.point.color.getValue
				&& e.point.color.getValue(v.clock.currentTime);
			return c && c.red > 0.9 && c.green > 0.9 && c.blue < 0.3;
		}) || null;
	}), { timeout: 25000 });
}, () => "the current waypoint is highlighted");

await check("RTL is accepted and the vehicle changes mode", async () => {
	await page.getByRole("button", { name: /^RTL/ }).first().click();
	return await until(async () => {
		const txt = await page.textContent("body");
		return /AUTO\.RTL/.test(txt) ? "AUTO.RTL" : null;
	}, { timeout: 20000 });
}, (v) => v || "");

await check("Disarm works and the UI reflects it", async () => {
	// RTL does not disarm, so the button is still "Disarm" here.
	await page.getByRole("button", { name: "Disarm", exact: true }).first().click();
	return await until(async () => {
		// The button itself is the state: it reads "Arm" again once the vehicle
		// reports disarmed. Checking body text for /Arm/ matched "Disarm".
		const names = await page.getByRole("button", { name: "Arm", exact: true }).count();
		return names > 0 ? "disarmed" : null;
	}, { timeout: 20000 });
}, (v) => v || "");

// --- 5. parameters --------------------------------------------------------
// An entire subsystem the unit tests cover at the store and gs never saw a
// browser: a 400-value refresh, an edit that goes to the vehicle and comes back
// confirmed, and the snapshot diff.
console.log("\n parameters");

await check("the parameter editor opens", async () => {
	await page.getByRole("button", { name: /vehicle configuration/i }).click();
	await page.getByRole("button", { name: /^Parameters$/ }).click();
	return await until(() => page.getByRole("button", { name: /^Refresh$/ })
		.isVisible().catch(() => false), { timeout: 10000 });
}, () => "Refresh on screen");

await check("Refresh downloads the whole parameter set", async () => {
	await page.getByRole("button", { name: /^Refresh$/ }).click();
	// The header prints the count, which is data rather than chrome.
	return await until(async () => {
		const m = (await page.textContent("body")).match(/(\d+) loaded/);
		return m && Number(m[1]) >= 100 ? Number(m[1]) : null;
	}, { timeout: 40000 });
}, (n) => `${n} parameters loaded`);

await check("a parameter can be found by searching", async () => {
	await page.getByPlaceholder(/search params/i).fill("P_001");
	return await until(() => page.textContent("body")
		.then((t) => /P_001/.test(t)), { timeout: 8000 });
}, () => "search filters the table");

await check("editing a parameter writes it and the vehicle confirms", async () => {
	// The row's input, then Enter. gs awaits the echoed PARAM_VALUE before it
	// acks, so a value that sticks here came back from the vehicle.
	// The row's value field is a plain text input (no `type`), so a
	// type=number selector matched nothing; scope it by the class it carries.
	const input = page.locator("input.w-20").first();
	await input.fill("42");
	await input.press("Enter");
	return await until(async () => {
		const v = await page.locator("input.w-20").first().inputValue();
		return v === "42" ? "42 confirmed by the vehicle" : null;
	}, { timeout: 20000 });
}, (v) => v || "");

await check("Save and Compare are offered once there is a set to snapshot",
	async () => {
		const save = page.getByRole("button", { name: /^Save$/ }).first();
		const cmp = page.getByRole("button", { name: /^Compare$/ }).first();
		const sd = await save.isDisabled();
		const cd = await cmp.isDisabled();
		if (sd || cd) throw new Error(`Save disabled=${sd} Compare disabled=${cd}`);
		return true;
	}, () => "both enabled");

// --- 6. recovery when the daemon goes away --------------------------------
// The hub is a Raspberry Pi; gs restarts. What the console does then is the
// difference between a reconnect and a lie.
console.log("\n recovery");

await check("killing gs is reported, not hidden", async () => {
	try { process.kill(-gs.pid, "SIGKILL"); } catch { /* already gone */ }
	return await until(() => page.textContent("body")
		.then((t) => /lost|stale|connecting/i.test(t.slice(0, 600))), { timeout: 25000 });
}, () => "the link indicator changed");

// Bring it back. Recovery is the part that matters: a console that notices the
// daemon left but cannot pick it up again has only noticed.
const gs2 = spawnLogged("gs2", "uv",
	["run", "python", "-u", "scripts/e2e_fixture.py", "--ws-port", String(WS_PORT)],
	{ cwd: GS_DIR });

await check("gs comes back", () => waitForLine(gs2, /^READY$/, 40000),
	() => "fixture up again");

// Section 6 is the only place two fixtures could ever overlap, and a run that
// overlaps them sees gs report two clocks on sysid 1 -- correctly -- which then
// clears the console's view of the vehicle and fails checks three sections
// later. A process-group kill of the first fixture was measured to take both
// the `uv` wrapper and its python child, so the surviving second clock is NOT
// an orphaned wrapper child and its origin is still unknown. Record the live
// processes here so the next occurrence names the source instead of inviting
// another theory.
try {
	const ps = execSync('ps -o pid,ppid,command -ax | grep "[e]2e_fixture.py" || true')
		.toString().trim();
	console.log(`  note after the restart, fixtures alive:\n${ps || "    (none)"}`);
} catch { /* diagnostic only */ }

await check("the console reconnects on its own", () =>
	until(() => page.textContent("body")
		.then((t) => /Airspeed/i.test(t) && !/connecting/i.test(t.slice(0, 400))),
	{ timeout: 40000 }),
	() => "telemetry flowing again");

await check("the parameter table is marked unverified, not silently kept",
	async () => {
		// gs cannot report what it did not witness, and the gap is exactly where
		// it was not watching: the vehicle may have rebooted, or this may be a
		// different aircraft. The values stay on screen; the claim that they are
		// current does not.
		//
		// The parameter editor is still open from the section above, deliberately:
		// it refreshes on first open, and a refresh clears the table AND the
		// stale flag — so reopening it here to look for the banner destroyed the
		// banner, which is how the first version of this check "failed".
		const found = await until(() => page.textContent("body")
			.then((t) => /unverified|predate/i.test(t)), { timeout: 25000 });
		if (!found) {
			const t = await page.textContent("body");
			const loaded = (t.match(/(\d+) loaded/) || [])[1];
			throw new Error(`no stale banner; ${loaded} params loaded`);
		}
		return found;
	}, () => "'these values predate it'");

await check("the plan pane stops claiming to know the vehicle's plan", async () => {
	// The draft is NOT cleared — it is the operator's work. What must change is
	// the claim: before this, a non-empty draft after a reconnect was shown with
	// nothing saying the vehicle's plan was now unknown, because the
	// empty-state message cannot appear while there is a plan to show.
	await openMissionPanel();
	return await until(() => page.textContent("body")
		.then((t) => /the vehicle's plan is not known|not read from the vehicle yet/i.test(t)),
	{ timeout: 20000 });
}, () => "'the vehicle's plan is not known'");

// --- 7. command authority across two consoles -----------------------------
// The hub serves several viewers at once, and only one may command. Tested
// here with two real browser contexts, which is the only way the claim and the
// takeover are exercised the way they are used.
console.log("\n command authority");

// The first console lost and re-won authority across the gs restart above, so
// settle that before a second console contends for it — otherwise the test is
// racing the reconnect rather than exercising the takeover.
await page.getByRole("button", { name: /^Commands$/i }).click().catch(() => {});
await until(() => page.textContent("body").then((t) => /IN CONTROL/i.test(t)),
	{ timeout: 20000 });

const second = await browser.newContext();
const tab2 = await second.newPage();
await tab2.goto(`http://localhost:${webPort}/flight`, { waitUntil: "domcontentloaded" });

await check("a second console connects and sees telemetry", () =>
	until(() => tab2.textContent("body").then((t) => /Airspeed/i.test(t)),
		{ timeout: 30000 }),
	() => "second tab live");

await check("the second console is told another holds command", async () => {
	await tab2.getByRole("button", { name: /^Commands$/i }).click().catch(() => {});
	return await until(() => tab2.textContent("body")
		.then((t) => /another console holds command/i.test(t)), { timeout: 20000 });
}, () => "'another console holds command'");

await check("Take command transfers authority to the second console", async () => {
	// Labelled "Take" in the command bar and "Take command" in the plan panels.
	await tab2.getByRole("button", { name: /^Take( command)?$/i }).first().click();
	return await until(() => tab2.textContent("body")
		.then((t) => !/another console holds command/i.test(t)), { timeout: 20000 });
}, () => "second console now commands");

await check("the first console is told it lost command", async () => {
	// It has to be on a surface that reports authority: the parameter editor
	// does not, and that is what the first tab had open.
	await page.getByRole("button", { name: /^Commands$/i }).click().catch(() => {});
	return await until(() => page.textContent("body")
		.then((t) => /another console (holds|took) command/i.test(t)), { timeout: 20000 });
}, () => "first console greyed out");

await tab2.close();
await second.close();

// --- 8. nothing broke along the way ---------------------------------------
console.log("\n over the whole run");
step("no uncaught page errors", pageErrors.length === 0,
	pageErrors.length ? pageErrors.slice(0, 2).join(" | ") : "none");
step("no swallowed handler errors in gs",
	!gs.lines.some((l) => /handler error/i.test(l)),
	gs.lines.filter((l) => /handler error/i.test(l)).length + " logged");

const failed = steps.filter((s) => !s.ok);
console.log();
if (failed.length === 0) {
	console.log(`  all ${steps.length} checks passed`);
} else {
	console.log(`  FAILED ${failed.length}/${steps.length}: ${failed.map((s) => s.name).join(", ")}`);
	console.log("\n  last gs lines:");
	console.log(gs.lines.slice(-8).map((l) => "    " + l).join("\n"));
}
console.log();

await browser.close();
shutdown();
process.exit(failed.length ? 1 : 0);export { browser, page, pageErrors, steps, step, check, until, shutdown, webPort, gs, web };
