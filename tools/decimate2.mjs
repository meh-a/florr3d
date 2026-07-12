// Position-only decimation: weld vertices by exact position (ignoring
// UV/normal seams — the texture is a flat color palette, so seam fidelity
// doesn't matter), then meshopt-simplify with Prune for disconnected bits.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [,, input, output, ratioArg, errorArg] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
await MeshoptSimplifier.ready;

for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const srcIdx = prim.getIndices().getArray();
    // canonical index per unique position
    const canon = new Map();
    const remap = new Uint32Array(pos.length / 3);
    for (let v = 0; v < pos.length / 3; v++) {
      const key = `${pos[v*3]},${pos[v*3+1]},${pos[v*3+2]}`;
      let c = canon.get(key);
      if (c === undefined) { c = v; canon.set(key, c); }
      remap[v] = c;
    }
    const welded = new Uint32Array(srcIdx.length);
    for (let i = 0; i < srcIdx.length; i++) welded[i] = remap[srcIdx[i]];
    const before = srcIdx.length / 3;
    const target = Math.floor(srcIdx.length * Number(ratioArg ?? 0.12) / 3) * 3;
    const [simplified, err] = MeshoptSimplifier.simplify(
      welded, pos, 3, target, Number(errorArg ?? 0.05), ['Prune']);
    prim.getIndices().setArray(simplified);
    console.log(`prim: ${before} -> ${simplified.length / 3} tris (err ${err.toFixed(4)}, unique pos ${canon.size})`);
  }
}
await doc.transform(prune());
await io.write(output, doc);
