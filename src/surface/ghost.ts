/** Призрак будущей дороги: полоса нужной ширины, лежащая поверх земли. */

import type { Road } from '../world/road.ts';
import type { World } from '../world/world.ts';
import { roadWidth } from '../world/road.ts';
import { groundHeightAt } from '../world/world.ts';
import { corridor, densify } from './clip.ts';
import { MeshBuilder, ROAD, carvePlane } from './mesh.ts';

export function buildGhost(world: World, road: Road): { positions: Float32Array; indices: Uint32Array } {
  const mesh = new MeshBuilder();
  const half = roadWidth(road.type) / 2 + road.type.sidewalk;
  const region = densify(corridor(road.centerline, half), 4);
  if (region.length === 0) return { positions: new Float32Array(), indices: new Uint32Array() };

  const plane = carvePlane([region], [], 0.7);
  const height = (x: number, z: number): number => groundHeightAt(world, x, z) + 0.2;
  const vertexOf = plane.points.map((p) => mesh.vertex(p.x, height(p.x, p.z), p.z, ROAD));
  const isInside = (x: number, z: number): boolean => {
    let hits = 0;
    for (const ring of region) {
      let is = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) is = !is;
      }
      if (is) hits++;
    }
    return hits % 2 === 1;
  };
  for (const f of plane.faces) {
    if (!isInside(f.x, f.z)) continue;
    mesh.triUp('asphalt', vertexOf[f.a], vertexOf[f.b], vertexOf[f.c]);
  }
  const surface = mesh.build();
  return { positions: surface.positions, indices: surface.indices };
}
