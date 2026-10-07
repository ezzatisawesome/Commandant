"use client";

import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import {
	ArcType, Cartesian3, CallbackProperty, CallbackPositionProperty, Cartographic,
	Color, Entity, LabelStyle, Math as CesiumMath, Transforms, Matrix3, Matrix4,
	VerticalOrigin,
} from "cesium";

import { $viewerStore } from "@/stores/cesium.store";
import { $aircraftStore } from "@/stores/aircraft.store";
import { $derived, setTerrainSampler, startDerived } from "@/stores/derived.store";
import { $showSun, $showWind, $showClearance } from "@/stores/viewControls.store";
import { isNum } from "@/lib/flightGeometry";

// Globe overlays for the derived situation: terrain clearance, wind and sun.
//
// Three rules this layer follows, so the scene stays readable as it gains data:
//
//  1. The colour budget is spent. cyan=actual track, orange=commanded,
//     white=plan, yellow=active item, green/red=fence. These overlays use
//     SHAPE and the vertical axis instead of new hues, except the clearance
//     drop-line, whose whole job is to encode one scalar as colour.
//  2. Nothing here is a time series. The globe answers "where".
//  3. Every entity is behind a toggle, because the globe has a finite budget of
//     attention and overlays should be opt-in.
//
// It also owns the terrain sampler: only the Cesium layer can read the globe's
// loaded tiles, so it publishes a sampler into derived.store, which stays
// Cesium-free and therefore testable.

const SUN_RAY_M = 2000;      // length of the sun direction line
const WIND_SCALE_M = 60;     // metres of arrow per m/s of wind
const WIND_MIN_M = 150;      // keep a light breeze visible

const CLEARANCE_COLOR = {
	critical: Color.RED,
	low: Color.ORANGE,
	ok: Color.LIME,
	unknown: Color.GRAY,
} as const;

export default function SituationLayer() {
	const $viewer = useStore($viewerStore);
	const showSun = useStore($showSun);
	const showWind = useStore($showWind);
	const showClearance = useStore($showClearance);

	// Terrain sampling + the derived recompute are global concerns, not per-entity.
	useEffect(() => {
		if (!$viewer) return;
		setTerrainSampler(() => {
			const f = $aircraftStore.get();
			if (!f || !isNum(f.lat) || !isNum(f.lon)) return null;
			// globe.getHeight reads only tiles already in memory and returns
			// undefined otherwise, which is the honest answer while they stream in.
			const h = $viewer.scene.globe.getHeight(
				Cartographic.fromDegrees(f.lon, f.lat),
			);
			return isNum(h) ? h : null;
		});
		const stopDerived = startDerived();
		return () => { setTerrainSampler(null); stopDerived(); };
	}, [$viewer]);

	useEffect(() => {
		if (!$viewer) return;
		const ents: Entity[] = [];

		/** Aircraft position, or undefined when there is no usable fix. */
		const here = (): Cartesian3 | undefined => {
			const f = $aircraftStore.get();
			if (!f || !isNum(f.lat) || !isNum(f.lon) || !isNum(f.alt)) return undefined;
			return Cartesian3.fromDegrees(f.lon, f.lat, f.alt);
		};

		/** East/north basis at the aircraft, for drawing compass-referenced vectors. */
		const basis = (p: Cartesian3) => {
			const enu = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(p), new Matrix3());
			return {
				east: Matrix3.getColumn(enu, 0, new Cartesian3()),
				north: Matrix3.getColumn(enu, 1, new Cartesian3()),
				up: Matrix3.getColumn(enu, 2, new Cartesian3()),
			};
		};

		/** A point `len` metres from `p` along a true bearing, optionally climbing. */
		const along = (p: Cartesian3, bearingDeg: number, len: number, elevDeg = 0) => {
			const { east, north, up } = basis(p);
			const b = CesiumMath.toRadians(bearingDeg);
			const e = CesiumMath.toRadians(elevDeg);
			const horiz = len * Math.cos(e);
			const out = Cartesian3.clone(p, new Cartesian3());
			Cartesian3.add(out, Cartesian3.multiplyByScalar(north, horiz * Math.cos(b), new Cartesian3()), out);
			Cartesian3.add(out, Cartesian3.multiplyByScalar(east, horiz * Math.sin(b), new Cartesian3()), out);
			Cartesian3.add(out, Cartesian3.multiplyByScalar(up, len * Math.sin(e), new Cartesian3()), out);
			return out;
		};

		// --- clearance drop-line -------------------------------------------
		// A vertical line from the aircraft down to the terrain beneath it,
		// coloured by clearance band. This uses the globe's unused third axis and
		// makes "how much air is under me" a glance rather than a subtraction.
		ents.push($viewer.entities.add({
			polyline: {
				width: 2,
				arcType: ArcType.NONE,
				positions: new CallbackProperty(() => {
					if (!$showClearance.get()) return undefined;
					const p = here();
					const terrain = $derived.get().terrainM;
					const f = $aircraftStore.get();
					if (!p || terrain === null || !f || !isNum(f.lat) || !isNum(f.lon)) return undefined;
					return [p, Cartesian3.fromDegrees(f.lon, f.lat, terrain)];
				}, false),
				material: new CallbackProperty(
					() => CLEARANCE_COLOR[$derived.get().clearance].withAlpha(0.55), false,
				) as unknown as Color,
			},
		}));

		// Ground marker at the aircraft's footprint: where it would come down.
		ents.push($viewer.entities.add({
			position: new CallbackPositionProperty(() => {
				if (!$showClearance.get()) return undefined;
				const terrain = $derived.get().terrainM;
				const f = $aircraftStore.get();
				if (terrain === null || !f || !isNum(f.lat) || !isNum(f.lon)) return undefined;
				return Cartesian3.fromDegrees(f.lon, f.lat, terrain);
			}, false),
			point: { pixelSize: 6, color: Color.WHITE.withAlpha(0.5) },
		}));

		// --- wind arrow -----------------------------------------------------
		// Drawn pointing the way the wind BLOWS (reciprocal of the reported
		// "from" bearing), scaled by speed, with a label carrying the number.
		ents.push($viewer.entities.add({
			polyline: {
				width: 3,
				arcType: ArcType.NONE,
				material: Color.AQUAMARINE.withAlpha(0.9),
				positions: new CallbackProperty(() => {
					if (!$showWind.get()) return undefined;
					const p = here();
					const w = $derived.get().wind;
					if (!p || !w || w.speedMps < 0.2) return undefined;
					const len = Math.max(WIND_MIN_M, w.speedMps * WIND_SCALE_M);
					return [p, along(p, (w.fromDeg + 180) % 360, len)];
				}, false),
			},
		}));
		ents.push($viewer.entities.add({
			position: new CallbackPositionProperty(() => {
				if (!$showWind.get()) return undefined;
				const p = here();
				const w = $derived.get().wind;
				if (!p || !w || w.speedMps < 0.2) return undefined;
				return along(p, (w.fromDeg + 180) % 360,
					Math.max(WIND_MIN_M, w.speedMps * WIND_SCALE_M));
			}, false),
			label: {
				text: new CallbackProperty(() => {
					const w = $derived.get().wind;
					return w ? `${w.speedMps.toFixed(1)} m/s` : "";
				}, false) as unknown as string,
				font: "11px monospace",
				fillColor: Color.AQUAMARINE,
				style: LabelStyle.FILL,
				verticalOrigin: VerticalOrigin.BOTTOM,
			},
		}));

		// --- sun vector -----------------------------------------------------
		// Where the sun is from the aircraft. For a solar aircraft this is a
		// navigation input: it says which way to turn for charge, and the globe
		// already renders day/night from the same clock.
		ents.push($viewer.entities.add({
			polyline: {
				width: 2,
				arcType: ArcType.NONE,
				material: Color.GOLD.withAlpha(0.8),
				positions: new CallbackProperty(() => {
					if (!$showSun.get()) return undefined;
					const p = here();
					const s = $derived.get().sun;
					if (!p || !s || s.elevationDeg <= 0) return undefined;   // no ray at night
					return [p, along(p, s.azimuthDeg, SUN_RAY_M, s.elevationDeg)];
				}, false),
			},
		}));

		return () => {
			ents.forEach((e) => $viewer.entities.remove(e));
			ents.length = 0;
		};
	}, [$viewer]);

	// Toggling visibility must ask for a frame, since requestRenderMode means
	// nothing redraws on its own.
	useEffect(() => { $viewer?.scene.requestRender(); },
		[showSun, showWind, showClearance, $viewer]);

	return null;
}
