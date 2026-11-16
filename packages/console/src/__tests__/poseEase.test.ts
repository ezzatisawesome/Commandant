import { describe, it, expect, afterEach } from "vitest";

import { easedPose, easeSample, easeUntilMs, MAX_EASE_MS } from "@/lib/poseEase";
import type { TelemetryFrame } from "@/types/app";

const at = (lat: number, yaw = 0): TelemetryFrame => ({ t: 0, connected: true, lat, lon: -122, alt: 100, roll: 0, pitch: 0, yaw });

afterEach(() => easeSample(null));

describe("poseEase", () => {
	it("draws the first sample as it is", () => {
		easeSample(at(37), 1000);
		expect(easedPose(1000)?.lat).toBe(37);
	});

	it("eases to a new sample over the interval since the last, never past it", () => {
		easeSample(at(37), 1000);
		easeSample(at(37.001), 1040);
		expect(easedPose(1040)!.lat).toBeCloseTo(37, 9);
		expect(easedPose(1060)!.lat).toBeCloseTo(37.0005, 9);
		expect(easedPose(1080)!.lat).toBeCloseTo(37.001, 9);
		expect(easedPose(2000)!.lat).toBeCloseTo(37.001, 9);
		expect(easeUntilMs()).toBe(1080);
	});

	it("turns the short way through north", () => {
		easeSample(at(37, Math.PI - 0.1), 1000);
		easeSample(at(37, -Math.PI + 0.1), 1040);
		const yaw = easedPose(1060)!.yaw;
		expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(1e-9);
	});

	it("starts from the drawn pose when a sample lands mid-ease (no jump back)", () => {
		easeSample(at(37), 1000);
		easeSample(at(37.001), 1040);
		const mid = easedPose(1060)!.lat;
		easeSample(at(37.002), 1060);
		expect(easedPose(1060)!.lat).toBeCloseTo(mid, 9);
	});

	it("jumps across a gap instead of crawling, and has nothing to ease when parked", () => {
		easeSample(at(37), 1000);
		easeSample(at(37.01), 1000 + MAX_EASE_MS + 1);
		expect(easedPose(1000 + MAX_EASE_MS + 1)!.lat).toBe(37.01);
		expect(easeUntilMs()).toBe(0);
		easeSample(at(37.01), 1000 + MAX_EASE_MS + 41);
		expect(easeUntilMs()).toBe(0);
	});

	it("has no pose without a fix", () => {
		easeSample({ t: 0, connected: true }, 1000);
		expect(easedPose(1000)).toBeNull();
	});
});
