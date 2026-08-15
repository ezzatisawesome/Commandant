// Generates a minimal valid glTF binary (.glb): a stretched box standing in for
// the solar airplane until a real glTF export of the airframe is dropped in.
// Forward is +X (matches Cesium's model convention with heading/pitch/roll).
// No dependencies. Run: node scripts/make-placeholder-glb.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HALF_LEN = 2.0; // X (fore/aft)
const HALF_SPAN = 3.0; // Y (wing span)
const HALF_HT = 0.3; // Z (thickness)

// 8 cube corners
const positions = [
	[-HALF_LEN, -HALF_SPAN, -HALF_HT],
	[HALF_LEN, -HALF_SPAN, -HALF_HT],
	[HALF_LEN, HALF_SPAN, -HALF_HT],
	[-HALF_LEN, HALF_SPAN, -HALF_HT],
	[-HALF_LEN, -HALF_SPAN, HALF_HT],
	[HALF_LEN, -HALF_SPAN, HALF_HT],
	[HALF_LEN, HALF_SPAN, HALF_HT],
	[-HALF_LEN, HALF_SPAN, HALF_HT],
];

// 12 triangles
const indices = [
	0, 1, 2, 0, 2, 3, // bottom
	4, 6, 5, 4, 7, 6, // top
	0, 4, 5, 0, 5, 1, // front
	1, 5, 6, 1, 6, 2, // right
	2, 6, 7, 2, 7, 3, // back
	3, 7, 4, 3, 4, 0, // left
];

const posArr = new Float32Array(positions.flat());
const idxArr = new Uint16Array(indices);

const posBytes = Buffer.from(posArr.buffer);
let idxBytes = Buffer.from(idxArr.buffer);
// pad index bytes to 4-byte alignment
if (idxBytes.length % 4 !== 0) {
	idxBytes = Buffer.concat([idxBytes, Buffer.alloc(4 - (idxBytes.length % 4))]);
}
const bin = Buffer.concat([posBytes, idxBytes]);

const min = [-HALF_LEN, -HALF_SPAN, -HALF_HT];
const max = [HALF_LEN, HALF_SPAN, HALF_HT];

const gltf = {
	asset: { version: "2.0", generator: "make-placeholder-glb" },
	scene: 0,
	scenes: [{ nodes: [0] }],
	nodes: [{ mesh: 0 }],
	meshes: [
		{
			primitives: [
				{ attributes: { POSITION: 1 }, indices: 0, material: 0 },
			],
		},
	],
	materials: [
		{
			pbrMetallicRoughness: {
				baseColorFactor: [0.85, 0.85, 0.9, 1.0],
				metallicFactor: 0.1,
				roughnessFactor: 0.8,
			},
		},
	],
	buffers: [{ byteLength: bin.length }],
	bufferViews: [
		{ buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
		{ buffer: 0, byteOffset: posBytes.length, byteLength: idxArr.byteLength, target: 34963 },
	],
	accessors: [
		{ bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" },
		{ bufferView: 0, componentType: 5126, count: positions.length, type: "VEC3", min, max },
	],
};

const jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
const jsonPad = jsonBuf.length % 4 === 0 ? 0 : 4 - (jsonBuf.length % 4);
const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
const binPad = bin.length % 4 === 0 ? 0 : 4 - (bin.length % 4);
const binChunk = Buffer.concat([bin, Buffer.alloc(binPad)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4); // version
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"

const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

const glb = Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);

const out = "public/models/solar-airplane.glb";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, glb);
console.log(`wrote ${out} (${glb.length} bytes)`);
