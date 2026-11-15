// Local east-north-up geometry on the globe, for handles that ride a ring.

import { Cartesian3, Matrix4, Transforms } from "cesium";

/** A point `east`/`north`/`up` metres from `origin`, in its local frame. */
export function enuOffset(origin: Cartesian3, east: number, north: number, up: number): Cartesian3 {
	const frame = Transforms.eastNorthUpToFixedFrame(origin);
	return Matrix4.multiplyByPoint(frame, new Cartesian3(east, north, up), new Cartesian3());
}

/** Bearing of `p` from `origin` in its local frame: radians CCW from east. */
export function enuBearing(origin: Cartesian3, p: Cartesian3): number {
	const toLocal = Matrix4.inverseTransformation(
		Transforms.eastNorthUpToFixedFrame(origin), new Matrix4(),
	);
	const local = Matrix4.multiplyByPoint(toLocal, p, new Cartesian3());
	return Math.atan2(local.y, local.x);
}
