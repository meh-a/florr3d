// simplifySloppy: topology-blind decimation for meshes whose non-manifold
// edges lock the regular simplifier. Fine at mob scale.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [,, input, output, ratioArg] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
await MeshoptSimplifier.ready;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const idx = prim.getIndices().getArray();
    const target = Math.floor(idx.length * Number(ratioArg ?? 0.12) / 3) * 3;
    const [out, err] = MeshoptSimplifier.simplifySloppy(
      new Uint32Array(idx), pos, 3, null, target, 0.3);
    prim.getIndices().setArray(out);
    console.log(`${idx.length / 3} -> ${out.length / 3} tris (err ${err.toFixed(4)})`);
  }
}
await doc.transform(prune());
await io.write(output, doc);
