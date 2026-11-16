import { atom } from "nanostores";

import type { ModelAnimation } from "@/lib/modelAnimation";
import type { WingLoads } from "@/lib/wingLoads";

// What the aircraft model says about itself besides its shapes: how its moving
// parts move (`animation`) and its wing's 1 g spanwise loading (`loads`). The sim
// writes these into the model file itself -- the glTF `extras`, glTF's slot for
// application data -- so they can never be separated from the mesh they
// describe. Cesium does not expose `extras`, so they are read here from the
// .glb's JSON chunk. Null until loaded, or for a model without them (it is then
// drawn rigid, with no loads).

export interface ModelMeta {
	animation?: ModelAnimation;
	loads?: WingLoads;
}

export const MODEL_URL = "/models/solar-airplane.glb";

export const $modelMeta = atom<ModelMeta | null>(null);

const GLB_MAGIC = 0x46546c67;   // "glTF"
const CHUNK_JSON = 0x4e4f534a;  // "JSON"

/** The `extras` of a binary glTF, or null if it is not one or has none. */
export function glbExtras(buf: ArrayBuffer): Record<string, unknown> | null {
	if (buf.byteLength < 20) return null;
	const v = new DataView(buf);
	if (v.getUint32(0, true) !== GLB_MAGIC || v.getUint32(16, true) !== CHUNK_JSON) return null;
	const len = v.getUint32(12, true);
	if (20 + len > buf.byteLength) return null;
	const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
	return gltf?.extras ?? null;
}

export async function loadModelMeta(url = MODEL_URL): Promise<ModelMeta | null> {
	try {
		const res = await fetch(url, { cache: "no-cache" });
		if (!res.ok) return null;
		const meta = glbExtras(await res.arrayBuffer()) as ModelMeta | null;
		$modelMeta.set(meta);
		return meta;
	} catch {
		return null;
	}
}
