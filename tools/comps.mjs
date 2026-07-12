import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const pos = prim.getAttribute('POSITION').getArray();
const idx = prim.getIndices().getArray();
const canon = new Map(); const remap = new Uint32Array(pos.length / 3);
for (let v = 0; v < pos.length / 3; v++) {
  const key = `${pos[v*3].toFixed(5)},${pos[v*3+1].toFixed(5)},${pos[v*3+2].toFixed(5)}`;
  let c = canon.get(key); if (c === undefined) { c = v; canon.set(key, c); }
  remap[v] = c;
}
// union-find over welded triangles
const parent = new Uint32Array(pos.length / 3).map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
for (let i = 0; i < idx.length; i += 3) {
  const a = find(remap[idx[i]]), b = find(remap[idx[i+1]]), c = find(remap[idx[i+2]]);
  parent[b] = a; parent[c] = a;
}
const compTris = new Map();
for (let i = 0; i < idx.length; i += 3) {
  const r = find(remap[idx[i]]);
  compTris.set(r, (compTris.get(r) || 0) + 1);
}
const sizes = [...compTris.values()].sort((a, b) => b - a);
console.log('components:', sizes.length);
console.log('largest 8:', sizes.slice(0, 8).join(', '));
const small = sizes.filter((s) => s <= 50);
console.log(`components ≤50 tris: ${small.length}, holding ${small.reduce((a, b) => a + b, 0)} tris`);
