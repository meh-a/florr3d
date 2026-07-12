// Per-component sloppy decimation: split the mesh into connected
// components first (body / outline hull / head are nested shells —
// clustering across them rips holes), then simplify each on its own.
// Needs: npm i --no-save meshoptimizer @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [,, input, output, ratioArg, errorArg] = process.argv;
const ratio = Number(ratioArg ?? 0.15), errCap = Number(errorArg ?? 0.05);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
await MeshoptSimplifier.ready;

for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const idx = prim.getIndices().getArray();
    const nVerts = pos.length / 3;
    // weld by position for connectivity only
    const canon = new Map(); const remap = new Uint32Array(nVerts);
    for (let v = 0; v < nVerts; v++) {
      const key = `${pos[v*3].toFixed(5)},${pos[v*3+1].toFixed(5)},${pos[v*3+2].toFixed(5)}`;
      let c = canon.get(key); if (c === undefined) { c = v; canon.set(key, c); }
      remap[v] = c;
    }
    const parent = new Uint32Array(nVerts).map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < idx.length; i += 3) {
      const a = find(remap[idx[i]]), b = find(remap[idx[i+1]]), c = find(remap[idx[i+2]]);
      parent[b] = a; parent[c] = a;
    }
    const byComp = new Map();
    for (let i = 0; i < idx.length; i += 3) {
      const r = find(remap[idx[i]]);
      if (!byComp.has(r)) byComp.set(r, []);
      byComp.get(r).push(idx[i], idx[i+1], idx[i+2]);
    }
    const out = [];
    for (const [, compIdx] of byComp) {
      const arr = new Uint32Array(compIdx);
      const target = Math.max(3, Math.floor(arr.length * ratio / 3) * 3);
      const [slim, err] = MeshoptSimplifier.simplifySloppy(arr, pos, 3, null, target, errCap);
      console.log(`  component: ${arr.length / 3} -> ${slim.length / 3} tris (err ${err.toFixed(4)})`);
      out.push(...slim);
    }
    prim.getIndices().setArray(new Uint32Array(out));
    console.log(`total: ${idx.length / 3} -> ${out.length / 3} tris`);
  }
}
await doc.transform(prune());
await io.write(output, doc);
