/**
 * Превращает мир в ОДНУ поверхность.
 * Земля и дорожное покрытие — части одной сетки треугольников с общими вершинами.
 * Поэтому «земля торчит сквозь дорогу» здесь невыразимо: торчать нечему сквозь что.
 *
 * Про Three.js этот файл не знает ничего — он выдаёт просто числа.
 */

import cdt2d from 'cdt2d';
import type { LaneKind } from './world/road.ts';
import type { World } from './world/world.ts';
import { WORLD_HALF, naturalHeight } from './world/terrain.ts';
import { bands } from './world/road.ts';
import { groundHeightAt } from './world/world.ts';

export type Material = 'grass' | 'asphalt' | 'sidewalk' | 'marking';

export interface SurfaceGroup {
  readonly material: Material;
  readonly start: number;
  readonly count: number;
}

export interface Surface {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly groups: readonly SurfaceGroup[];
  /** сколько вершин и треугольников получилось — для проверок */
  readonly stats: { vertices: number; triangles: number };
}

const MATERIAL_OF: Record<LaneKind, Material> = {
  travel: 'asphalt',
  sidewalk: 'sidewalk',
  marking: 'marking',
};

/** Шаг сетки земли, метры. */
const GRID_STEP = 3;
/** Насколько близко к дороге сетке земли подходить нельзя. */
const KEEP_CLEAR = 1.5;

function pointInRing(ring: readonly number[][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export interface SurfaceOptions {
  /**
   * Заведомо сломанный случай для проверки инструмента:
   * дорога становится отдельной плоскостью, положенной на землю,
   * а земля живёт своей жизнью. Это вариант, от которого мы отказались.
   */
  readonly detachRoad?: boolean;
}

export function buildSurface(world: World, options: SurfaceOptions = {}): Surface {
  const positions: number[] = [];
  const byMaterial: Record<Material, number[]> = { grass: [], asphalt: [], sidewalk: [], marking: [] };

  const addVertex = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const addQuad = (m: Material, a: number, b: number, c: number, d: number): void => {
    byMaterial[m].push(a, b, c, a, c, d);
  };

  // --- дорожное полотно: полосы вдоль осевой линии ---
  const rings: { indices: number[]; xz: number[][] }[] = [];

  for (const shape of world.shapes) {
    const band = bands(shape.road.type);
    if (band.length === 0 || shape.stations.length < 2) continue;

    const offsets = [band[0].from, ...band.map((b) => b.to)];
    const grid: number[][] = [];

    shape.stations.forEach((st, i) => {
      const y = shape.height[i];
      grid.push(offsets.map((off) => addVertex(st.x + st.nx * off, y, st.z + st.nz * off)));
    });

    for (let i = 0; i + 1 < grid.length; i++) {
      for (let b = 0; b < band.length; b++) {
        addQuad(MATERIAL_OF[band[b].kind], grid[i][b], grid[i][b + 1], grid[i + 1][b + 1], grid[i + 1][b]);
      }
    }

    // граница коридора: левый край вперёд, правый край назад
    const last = offsets.length - 1;
    const ringIdx: number[] = [];
    for (let i = 0; i < grid.length; i++) ringIdx.push(grid[i][0]);
    for (let i = grid.length - 1; i >= 0; i--) ringIdx.push(grid[i][last]);
    rings.push({ indices: ringIdx, xz: ringIdx.map((v) => [positions[v * 3], positions[v * 3 + 2]]) });
  }

  // --- земля: сетка, обходящая коридоры, сшитая с ними по общим вершинам ---
  const cdtPoints: number[][] = [];
  const cdtToVertex: number[] = [];
  const cdtEdges: number[][] = [];

  for (const ring of rings) {
    const base = cdtPoints.length;
    ring.indices.forEach((v, k) => {
      cdtPoints.push(ring.xz[k]);
      const [rx, rz] = ring.xz[k];
      // в обычном режиме земля берёт ту же самую вершину, что и дорога —
      // именно поэтому между ними не может появиться щель
      cdtToVertex.push(options.detachRoad ? addVertex(rx, naturalHeight(rx, rz), rz) : v);
    });
    for (let i = 0; i < ring.indices.length; i++) {
      cdtEdges.push([base + i, base + ((i + 1) % ring.indices.length)]);
    }
  }

  const steps = Math.round((WORLD_HALF * 2) / GRID_STEP);
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = -WORLD_HALF + i * GRID_STEP;
      const z = -WORLD_HALF + j * GRID_STEP;
      const tooClose = rings.some((r) => pointInRing(r.xz, x, z)) ||
        world.shapes.some((s) => {
          for (const st of s.stations) {
            if (Math.hypot(st.x - x, st.z - z) < s.halfWidth + KEEP_CLEAR) return true;
          }
          return false;
        });
      if (tooClose) continue;
      cdtPoints.push([x, z]);
      cdtToVertex.push(addVertex(x, groundHeightAt(world, x, z), z));
    }
  }

  for (const tri of cdt2d(cdtPoints, cdtEdges, { delaunay: true, exterior: true, interior: true })) {
    const [a, b, c] = tri;
    const cx = (cdtPoints[a][0] + cdtPoints[b][0] + cdtPoints[c][0]) / 3;
    const cz = (cdtPoints[a][1] + cdtPoints[b][1] + cdtPoints[c][1]) / 3;
    if (rings.some((r) => pointInRing(r.xz, cx, cz))) continue;
    byMaterial.grass.push(cdtToVertex[a], cdtToVertex[c], cdtToVertex[b]);
  }

  // --- склеиваем в один буфер ---
  const indices: number[] = [];
  const groups: SurfaceGroup[] = [];
  (Object.keys(byMaterial) as Material[]).forEach((material) => {
    const list = byMaterial[material];
    if (list.length === 0) return;
    groups.push({ material, start: indices.length, count: list.length });
    indices.push(...list);
  });

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    groups,
    stats: { vertices: positions.length / 3, triangles: indices.length / 3 },
  };
}
