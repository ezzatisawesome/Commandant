// PX4 parameter metadata (units / range / help), bundled from the firmware build.
//
// MAVLink carries only a param's name/value/type on the wire — not its units,
// min/max, or description. PX4 generates all of that into a parameters.json at
// build time; we ship a copy at public/px4-params.json and match it to live
// params by name. See public/px4-params.README.md for provenance.

export interface ParamMeta {
	name: string;
	shortDesc?: string;
	longDesc?: string;
	min?: number;
	max?: number;
	units?: string;
	type?: string;      // "Int32" | "Float" | …
	default?: number;
	group?: string;
}

let cache: Record<string, ParamMeta> | null = null;
let loading: Promise<Record<string, ParamMeta>> | null = null;

// Load + index the metadata once (idempotent). Resolves to {} if the asset is
// missing, so the editor degrades to value-only rather than failing.
export function loadParamMeta(): Promise<Record<string, ParamMeta>> {
	if (cache) return Promise.resolve(cache);
	if (loading) return loading;
	loading = fetch("/px4-params.json")
		.then((r) => (r.ok ? r.json() : { parameters: [] }))
		.then((j: { parameters?: ParamMeta[] }) => {
			const out: Record<string, ParamMeta> = {};
			for (const p of j.parameters ?? []) {
				if (p?.name) out[p.name] = p;
			}
			cache = out;
			return out;
		})
		.catch(() => {
			cache = {};
			return cache;
		});
	return loading;
}

// Look a param up by exact name, falling back to the upper-cased name (PX4 core
// params are upper-case; some bundled vendor params are lower-case).
export function lookupMeta(meta: Record<string, ParamMeta>, name: string): ParamMeta | undefined {
	return meta[name] ?? meta[name.toUpperCase()];
}

// Validate a candidate value against the metadata's range/type. Returns an error
// string if invalid, or null if acceptable (or if there's no metadata to check).
export function validateParam(meta: ParamMeta | undefined, value: number): string | null {
	if (!Number.isFinite(value)) return "not a number";
	if (!meta) return null;
	if ((meta.type === "Int32" || meta.type === "Int16") && !Number.isInteger(value)) {
		return "must be an integer";
	}
	if (meta.min !== undefined && value < meta.min) return `below min (${meta.min})`;
	if (meta.max !== undefined && value > meta.max) return `above max (${meta.max})`;
	return null;
}
