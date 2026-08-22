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
import { WORLD_HALF } from './world/terrain.ts';
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
/** На каких расстояниях от края дороги ставим точки вдоль откоса, метры. */
const SLOPE_RINGS = [1.8, 4.5, 8.5, 14, 22];

type AddVertex = (x: number, y: number, z: number) => number;
type AddQuad = (material: Material, a: number, b: number, c: number, d: number) => void;
type AddTri = (material: Material, a: number, b: number, c: number) => void;

function pointInRing(ring: readonly number[][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** За сколько станций бордюр сходит на нет у торца дороги. */
const CURB_TAPER = 3;

/**
 * Полотно дороги: полосы вдоль осевой линии.
 * Возвращает вершины внешней границы коридора — по ним земля пришивается
 * к дороге, беря те же самые вершины.
 *
 * У торцов бордюр сходит на нет: иначе поперечное сечение конца дороги —
 * ступенька, а в виде сверху две точки границы сливаются в одну, и землю
 * к такому торцу пришить нельзя.
 */
function roadStrips(shape: RoadShape, addVertex: AddVertex, addQuad: AddQuad, addTri: AddTri): number[] {
  const band: Band[] = bands(shape.road.type);
  const n = shape.stations.length - 1;
  if (band.length === 0 || n < 1) return [];

  const taper = (i: number): number => Math.min(1, Math.min(i, n - i) / CURB_TAPER);

  const left: number[][] = [];
  const right: number[][] = [];

  shape.stations.forEach((st, i) => {
    const base = shape.height[i];
    const t = taper(i);
    const rowLeft: number[] = [];
    const rowRight: number[] = [];
    const at = (offset: number, rise: number): number =>
      addVertex(st.x + st.nx * offset, base + rise * t, st.z + st.nz * offset);

    band.forEach((b, k) => {
      // одинаковая высота у соседних полос — вершина общая, шва нет
      const sameAsPrev = k > 0 && (band[k - 1].rise === b.rise || t === 0);
      rowLeft.push(sameAsPrev ? rowRight[k - 1] : at(b.from, b.rise));
      rowRight.push(at(b.to, b.rise));
    });
    left.push(rowLeft);
    right.push(rowRight);
  });

  for (let i = 0; i < n; i++) {
    band.forEach((b, k) => {
      addQuad(MATERIAL_OF[b.kind], left[i][k], right[i][k], right[i + 1][k], left[i + 1][k]);
      if (k <= 0 || band[k - 1].rise === b.rise) return;

      // Вертикальная стенка между полосами разной высоты — это и есть бордюр.
      // У неё СВОИ вершины, хотя лежат они там же, где вершины асфальта и
      // тротуара. Иначе освещение усреднится между стенкой и горизонталью,
      // и острое ребро размажется в пологий скат.
      const edge = b.from;
      const corner = (m: number): { low: number; high: number } => {
        const st = shape.stations[m];
        const y = shape.height[m];
        const t = taper(m);
        const put = (rise: number): number => addVertex(st.x + st.nx * edge, y + rise * t, st.z + st.nz * edge);
        if (t === 0) {
          const shared = put(0);
          return { low: shared, high: shared };
        }
        return { low: put(band[k - 1].rise), high: put(b.rise) };
      };
      const a = corner(i);
      const c = corner(i + 1);
      if (a.low === a.high) addTri('curb', a.low, c.high, c.low);
      else if (c.low === c.high) addTri('curb', a.low, a.high, c.low);
      else addQuad('curb', a.low, a.high, c.high, c.low);
    });
  }

  // Граница коридора. У торцов идём поперёк по всем точкам границы полос,
  // иначе у земли там одно длинное ребро против нескольких коротких у дороги —
  // и по этому месту пойдёт щель.
  const last = band.length - 1;
  const across = (i: number): number[] => {
    const out = [left[i][0]];
    for (let k = 0; k <= last; k++) if (right[i][k] !== out[out.length - 1]) out.push(right[i][k]);
    return out;
  };

  const ring: number[] = [];
  for (let i = 1; i < n; i++) ring.push(left[i][0]);
  ring.push(...across(n));
  for (let i = n - 1; i >= 1; i--) ring.push(right[i][last]);
  ring.push(...across(0).reverse());
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
  const addTri: AddTri = (m, a, b, c) => {
    byMaterial[m].push(a, b, c);
  };
  const addQuad: AddQuad = (m, a, b, c, d) => {
    byMaterial[m].push(a, b, c, a, c, d);
  };

  const rings = world.shapes
    .map((shape) => roadStrips(shape, addVertex, addQuad, addTri))
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
      cdtToVertex.push(options.detachRoad ? addVertex(rx, world.terrain(rx, rz), rz) : v);
    });
    for (let i = 0; i < ring.indices.length; i++) {
      cdtEdges.push([base + i, base + ((i + 1) % ring.indices.length)]);
    }
  }

  // Точки земли, идущие ВДОЛЬ дороги: без них откос ложится на редкую
  // прямоугольную сетку и выглядит рваным.
  const addGroundPoint = (x: number, z: number): void => {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return;
    if (rings.some((r) => pointInRing(r.xz, x, z))) return;
    if (world.shapes.some((s) => s.stations.some((st) => Math.hypot(st.x - x, st.z - z) < s.halfWidth + KEEP_CLEAR))) return;
    cdtPoints.push([x, z]);
    cdtToVertex.push(addVertex(x, groundHeightAt(world, x, z), z));
  };

  for (const shape of world.shapes) {
    for (let i = 0; i < shape.stations.length; i += 2) {
      const st = shape.stations[i];
      for (const away of SLOPE_RINGS) {
        for (const side of [1, -1]) {
          const off = side * (shape.halfWidth + away);
          addGroundPoint(st.x + st.nx * off, st.z + st.nz * off);
        }
      }
    }
  }

  const steps = Math.round((WORLD_HALF * 2) / GRID_STEP);
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = -WORLD_HALF + i * GRID_STEP;
      const z = -WORLD_HALF + j * GRID_STEP;
      addGroundPoint(x, z);
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
  const addTri: AddTri = (_m, a, b, c) => {
    indices.push(a, b, c);
  };
  roadStrips(shape, addVertex, addQuad, addTri);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
