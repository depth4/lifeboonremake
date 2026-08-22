/**
 * Превращает мир в ОДНУ поверхность.
 * Земля и дорожное покрытие — части одной сетки треугольников с общими вершинами.
 * Поэтому «земля торчит сквозь дорогу» здесь невыразимо: торчать нечему сквозь что.
 *
 * Бордюр не является отдельной сущностью: он возникает сам там, где у соседних
 * полос разная высота над проезжей частью.
 *
 * Про Three.js этот файл не знает ничего — он выдаёт просто числа.
 */

import cdt2d from 'cdt2d';
import type { Band, LaneKind } from './world/road.ts';
import type { RoadShape, World } from './world/world.ts';
import { WORLD_HALF, naturalHeight } from './world/terrain.ts';
import { bands } from './world/road.ts';
import { groundHeightAt } from './world/world.ts';

export type Material = 'grass' | 'asphalt' | 'sidewalk' | 'marking' | 'median' | 'curb';

export interface SurfaceGroup {
  readonly material: Material;
  readonly start: number;
  readonly count: number;
}

export interface Surface {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly groups: readonly SurfaceGroup[];
  readonly stats: { vertices: number; triangles: number };
}

const MATERIAL_OF: Record<LaneKind, Material> = {
  travel: 'asphalt',
  sidewalk: 'sidewalk',
  marking: 'marking',
  median: 'median',
};

/** Шаг сетки земли, метры. */
const GRID_STEP = 3;
/** Насколько близко к дороге сетке земли подходить нельзя. */
const KEEP_CLEAR = 1.5;

type AddVertex = (x: number, y: number, z: number) => number;
type AddQuad = (material: Material, a: number, b: number, c: number, d: number) => void;

function pointInRing(ring: readonly number[][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Полотно дороги: полосы вдоль осевой линии.
 * Возвращает вершины внешней границы коридора — по ним земля пришивается
 * к дороге, беря те же самые вершины.
 */
function roadStrips(shape: RoadShape, addVertex: AddVertex, addQuad: AddQuad): number[] {
  const band: Band[] = bands(shape.road.type);
  if (band.length === 0 || shape.stations.length < 2) return [];

  // на каждой станции: левая и правая вершина каждой полосы на её собственной высоте
  const left: number[][] = [];
  const right: number[][] = [];

  shape.stations.forEach((st, i) => {
    const base = shape.height[i];
    const rowLeft: number[] = [];
    const rowRight: number[] = [];
    const at = (offset: number, rise: number): number =>
      addVertex(st.x + st.nx * offset, base + rise, st.z + st.nz * offset);

    band.forEach((b, k) => {
      // если у соседней полосы та же высота — вершина у них общая, шва нет
      rowLeft.push(k > 0 && band[k - 1].rise === b.rise ? rowRight[k - 1] : at(b.from, b.rise));
      rowRight.push(at(b.to, b.rise));
    });
    left.push(rowLeft);
    right.push(rowRight);
  });

  for (let i = 0; i + 1 < shape.stations.length; i++) {
    band.forEach((b, k) => {
      addQuad(MATERIAL_OF[b.kind], left[i][k], right[i][k], right[i + 1][k], left[i + 1][k]);
      // вертикальная стенка между полосами разной высоты — это и есть бордюр
      if (k > 0 && band[k - 1].rise !== b.rise) {
        addQuad('curb', right[i][k - 1], left[i][k], left[i + 1][k], right[i + 1][k - 1]);
      }
    });
  }

  const last = band.length - 1;
  const ring: number[] = [];
  for (let i = 0; i < shape.stations.length; i++) ring.push(left[i][0]);
  for (let i = shape.stations.length - 1; i >= 0; i--) ring.push(right[i][last]);
  return ring;
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
  const byMaterial: Record<Material, number[]> = {
    grass: [], asphalt: [], sidewalk: [], marking: [], median: [], curb: [],
  };

  const addVertex: AddVertex = (x, y, z) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const addQuad: AddQuad = (m, a, b, c, d) => {
    byMaterial[m].push(a, b, c, a, c, d);
  };

  const rings = world.shapes
    .map((shape) => roadStrips(shape, addVertex, addQuad))
    .filter((ring) => ring.length > 0)
    .map((ring) => ({ indices: ring, xz: ring.map((v) => [positions[v * 3], positions[v * 3 + 2]]) }));

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
        world.shapes.some((s) => s.stations.some((st) => Math.hypot(st.x - x, st.z - z) < s.halfWidth + KEEP_CLEAR));
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

/**
 * Только полотно дороги, без земли — для предпросмотра при строительстве.
 * Считается тем же кодом, что и настоящая дорога, поэтому предпросмотр
 * не может соврать про ширину.
 */
export function buildRoadRibbon(shape: RoadShape): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  const addVertex: AddVertex = (x, y, z) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const addQuad: AddQuad = (_m, a, b, c, d) => {
    indices.push(a, b, c, a, c, d);
  };
  roadStrips(shape, addVertex, addQuad);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
