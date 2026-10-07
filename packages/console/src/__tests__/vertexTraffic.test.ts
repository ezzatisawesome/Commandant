import { describe, it, expect, beforeEach } from "vitest";

import {
	pushFrame, $trailStore, $targetTrailStore, $historyStore,
	$aircraftStore, $hudFrame, $trailChunks, $trailTail,
	$targetChunks, $targetTail, trailAllPoints,
} from "@/stores/aircraft.store";
import type { TelemetryFrame } from "@/types/app";

// A Cesium polyline re-uploads its ENTIRE vertex buffer whenever its positions
// array reference changes — not just the new points. So a single growing trail
// costs O(length) per append, which measured at 17,500 points/s (~420 KB/s of
// vertex traffic) for one 3000-point trail at 13 m/s, and did not shrink with
// time. Storing the path as frozen chunks plus a short active tail makes it
// O(chunk) instead.
//
// This test is the guard on that property. If someone collapses the trail back
// into one array, the numbers here blow up and say so.

const LAT = 37.3985511, LON = -122.148853, M = 111_320;
const HZ = 25, SPEED = 13;

const mk = (i: number): TelemetryFrame => ({
	t: 10_000 + i * (1000 / HZ), connected: true,
	lat: LAT + (i * SPEED / HZ) / M, lon: LON, alt: 233,
	targetLat: LAT + (i * SPEED / HZ) / M + 0.0002, targetLon: LON,
});

beforeEach(() => {
	$aircraftStore.set(null); $hudFrame.set(null); $historyStore.set([]);
	$trailStore.set([]); $targetTrailStore.set([]);
	$trailChunks.set([]); $trailTail.set([]);
	$targetChunks.set([]); $targetTail.set([]);
	pushFrame({ t: 0, connected: false });
	$trailStore.set([]); $historyStore.set([]);
});

/** Points Cesium would re-upload: every tail change costs the tail's length;
 *  every chunk close costs that chunk once. Frozen chunks cost nothing after. */
function measure(seconds: number) {
	let pts = 0, tailChanges = 0, chunkCloses = 0;
	const un1 = $trailTail.listen((v) => { tailChanges++; pts += v.length; });
	const un2 = $trailChunks.listen((v) => {
		chunkCloses++;
		pts += v.length ? v[v.length - 1].length : 0;
	});
	for (let i = 0; i < HZ * seconds; i++) pushFrame(mk(i));
	un1(); un2();
	return { perSecond: pts / seconds, tailChanges, chunkCloses };
}

describe("trail vertex traffic", () => {
	it("stays bounded per second instead of scaling with trail length", () => {
		const ten = measure(600);
		// A single-array trail measured ~11,000 points/s over this window and kept
		// climbing. Chunked, it is an order of magnitude lower.
		expect(ten.perSecond).toBeLessThan(2000);
		expect(ten.tailChanges).toBeGreaterThan(0);
	});

	it("does NOT grow as the flight gets longer — the key property", () => {
		const short = measure(300).perSecond;
		beforeEachReset();
		const long = measure(1800).perSecond;
		// With one array, a longer flight means a longer trail means more bytes per
		// append. Chunked, the rate is flat: within 25% across a 6x longer flight.
		expect(long).toBeLessThan(short * 1.25);
	});

	it("keeps the path continuous across chunk boundaries", () => {
		for (let i = 0; i < HZ * 600; i++) pushFrame(mk(i));
		const chunks = $trailChunks.get();
		expect(chunks.length).toBeGreaterThan(1);
		// Each chunk starts where the previous ended, so the drawn line has no gaps.
		for (let c = 1; c < chunks.length; c++) {
			const prevEnd = chunks[c - 1][chunks[c - 1].length - 1];
			expect(chunks[c][0]).toBe(prevEnd);
		}
		const tail = $trailTail.get();
		expect(tail[0]).toBe(chunks[chunks.length - 1][chunks[chunks.length - 1].length - 1]);
	});

	it("bounds total retained points, so memory does not creep on a long flight", () => {
		for (let i = 0; i < HZ * 7200; i++) pushFrame(mk(i));   // 2 hours
		// 12 chunks x 250 plus one overlap point each plus the tail. The overlaps
		// are what make the drawn line gap-free, so they are a deliberate cost.
		expect(trailAllPoints().length).toBeLessThanOrEqual(3300);
		expect($trailChunks.get().length).toBeLessThanOrEqual(12);
	});

	it("applies the same treatment to the commanded path", () => {
		for (let i = 0; i < HZ * 600; i++) pushFrame(mk(i));
		expect($targetChunks.get().length).toBeGreaterThan(1);
		expect($targetTail.get().length).toBeLessThanOrEqual(251);
	});
});

function beforeEachReset() {
	$trailStore.set([]); $targetTrailStore.set([]);
	$trailChunks.set([]); $trailTail.set([]);
	$targetChunks.set([]); $targetTail.set([]);
	$historyStore.set([]);
	pushFrame({ t: 0, connected: false });
	$trailStore.set([]); $historyStore.set([]);
}
