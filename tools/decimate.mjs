// Aggressive ladybug decimation: weld, then meshopt simplify with the
// Prune flag (drops tiny disconnected shells the normal path can't touch).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('/home/meh/fl/client/assets-src/ladybug.glb');
await MeshoptSimplifier.ready;

const tris = () => {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) n += prim.getIndices().getCount() / 3;
  return Math.round(n);
};
console.log('before:', tris());

await doc.transform(dedup(), weld());
// simplify with pruning of disconnected components
MeshoptSimplifier.useExperimentalFeatures = true;
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.12, error: 0.05, prune: true }));
console.log('after simplify:', tris());
await doc.transform(prune());
await io.write('/tmp/ladybug-decimated.glb', doc);
console.log('written');
