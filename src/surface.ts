/**
 * Превращает мир в ОДНУ поверхность.
 * Земля, полотна дорог и площадки перекрёстков — части одной сетки
 * треугольников с общими вершинами. Поэтому «земля торчит сквозь дорогу»
 * здесь невыразимо: торчать нечему сквозь что.
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
/** За сколько станций бордюр сходит на нет у торца дороги. */
const CURB_TAPER = 3;

type AddVertex = (x: number, y: number, z: number) => number;
type AddQuad = (material: Material, a: number, b: number, c: number, d: number) => void;
type AddTri = (material: Material, a: number, b: number, c: number) => void;

interface Strips {
  /** граница коридора, обход по кругу */
  readonly ring: number[];
  /** поперечник начала: вершины от -полуширины к +полуширине */
  readonly startCross: number[];
  /** поперечник конца, в том же порядке */
  readonly endCross: number[];
}

/**
 * Пересекаются ли отрезки строго внутри себя.
 *
 * Сначала грубо отсекаем по габаритам: без этого два коллинеарных звена
 * в сотне метров друг от друга давали ложное срабатывание на дрожании
 * последних знаков. Плюс допуск: почти касание пересечением не считаем.
 */
function segmentsCross(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  if (Math.min(a1[0], a2[0]) > Math.max(b1[0], b2[0])) return false;
  if (Math.max(a1[0], a2[0]) < Math.min(b1[0], b2[0])) return false;
  if (Math.min(a1[1], a2[1]) > Math.max(b1[1], b2[1])) return false;
  if (Math.max(a1[1], a2[1]) < Math.min(b1[1], b2[1])) return false;

  const side = (p: number[], q: number[], r: number[]): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const eps = 1e-6;
  const opposite = (u: number, v: number): boolean => (u > eps && v < -eps) || (u < -eps && v > eps);

  return (
    opposite(side(a1, a2, b1), side(a1, a2, b2)) &&
    opposite(side(b1, b2, a1), side(b1, b2, a2))
  );
}

/**
 * Контуры дорожных полотен и площадок обязаны быть простыми и не накладываться.
 * Если нарушено — землю вокруг них построить нельзя: триангуляция даёт дырки
 * или падает. Такую постройку мир не принимает. Это и есть «сделать
 * невозможным» вместо «ловить»: всё, что построилось, гарантированно целое.
 */
function ringsAreSound(rings: readonly { xz: number[][] }[]): string | null {
  const segs = rings.map((r) => r.xz.map((p, i) => [p, r.xz[(i + 1) % r.xz.length]]));
  for (let a = 0; a < segs.length; a++) {
    for (let b = a; b < segs.length; b++) {
      for (let i = 0; i < segs[a].length; i++) {
        const startJ = a === b ? i + 2 : 0;
        for (let j = startJ; j < segs[b].length; j++) {
          if (a === b && j === segs[b].length - 1 && i === 0) continue;
          if (segmentsCross(segs[a][i][0], segs[a][i][1], segs[b][j][0], segs[b][j][1])) {
            const f = (q: number[]): string => `[${q[0].toFixed(1)}, ${q[1].toFixed(1)}]`;
            const p1 = segs[a][i][0], p2 = segs[b][j][0];
            if (a !== b) {
              return `контуры ${a} и ${b}: звено ${f(segs[a][i][0])}→${f(segs[a][i][1])} против ${f(segs[b][j][0])}→${f(segs[b][j][1])}`;
            }
            return a === b
              ? `контур ${a} пересекает сам себя у [${p1[0].toFixed(1)}, ${p1[1].toFixed(1)}]`
              : `контуры ${a} и ${b} пересекаются у [${p1[0].toFixed(1)}, ${p1[1].toFixed(1)}] и [${p2[0].toFixed(1)}, ${p2[1].toFixed(1)}]`;
          }
        }
      }
    }
  }
  // Один контур целиком внутри другого — тоже наложение. Соседние контуры
  // делят вершины, и попадание такой вершины «внутрь» ненадёжно, поэтому
  // смотрим большинство точек, а не одну.
  for (let a = 0; a < rings.length; a++) {
    for (let b = 0; b < rings.length; b++) {
      if (a === b) continue;
      let inside = 0;
      for (const p of rings[a].xz) if (pointInRing(rings[b].xz, p[0], p[1])) inside++;
      if (inside * 2 > rings[a].xz.length) return `контур ${a} лежит внутри контура ${b}`;
    }
  }
  return null;
}

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
 * У торцов бордюр сходит на нет: иначе поперечное сечение торца — ступенька,
 * а в виде сверху две точки границы сливаются в одну, и землю к такому
 * торцу пришить нельзя.
 */
function roadStrips(shape: RoadShape, addVertex: AddVertex, addQuad: AddQuad, addTri: AddTri): Strips | null {
  const band: Band[] = bands(shape.type);
  const n = shape.stations.length - 1;
  if (band.length === 0 || n < 1) return null;

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
      // У неё свои вершины: иначе освещение усреднится между стенкой и
      // горизонталью, и острое ребро размажется в пологий скат.
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

  return { ring, startCross: across(0), endCross: across(n) };
}

export interface SurfaceOptions {
  /**
   * Заведомо сломанный случай для проверки инструмента: дорога становится
   * отдельной плоскостью поверх земли, а земля живёт своей жизнью.
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

  const xzOf = (v: number): number[] => [positions[v * 3], positions[v * 3 + 2]];
  const rings: { indices: number[]; xz: number[][] }[] = [];

  // --- полотна ---
  const strips = world.shapes.map((shape) => roadStrips(shape, addVertex, addQuad, addTri));
  for (const s of strips) {
    if (s) rings.push({ indices: s.ring, xz: s.ring.map(xzOf) });
  }

  // --- площадки перекрёстков: обход торцов подрезанных коридоров по кругу ---
  for (const junction of world.junctions) {
    const loop: number[] = [];
    for (const end of junction.ends) {
      const s = strips[end.shape];
      if (!s) continue;
      const cross = end.atStart ? s.startCross : [...s.endCross].reverse();
      for (const v of cross) if (v !== loop[loop.length - 1]) loop.push(v);
    }
    if (loop.length < 3) continue;

    const middle = addVertex(junction.x, junction.height, junction.z);
    for (let i = 0; i < loop.length; i++) {
      // Порядок обхода считаем по самим точкам, а не предполагаем: тогда
      // «площадка смотрит изнанкой вверх» становится невыразимым.
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const turn =
        (positions[a * 3] - junction.x) * (positions[b * 3 + 2] - junction.z) -
        (positions[a * 3 + 2] - junction.z) * (positions[b * 3] - junction.x);
      if (Math.abs(turn) < 1e-9) continue;
      if (turn < 0) addTri('asphalt', middle, a, b);
      else addTri('asphalt', middle, b, a);
    }
    rings.push({ indices: loop, xz: loop.map(xzOf) });
  }

  const unsound = ringsAreSound(rings);
  if (unsound !== null) {
    throw new Error(`дороги накладываются друг на друга — так построить нельзя (${unsound})`);
  }

  // --- земля: сетка, обходящая коридоры и площадки, сшитая с ними по общим вершинам ---
  const cdtPoints: number[][] = [];
  const cdtToVertex: number[] = [];
  const cdtEdges: number[][] = [];
  const seen = new Map<string, number>();

  for (const ring of rings) {
    const mapped: number[] = [];
    ring.indices.forEach((v, k) => {
      const [rx, rz] = ring.xz[k];
      const key = `${Math.round(rx * 1000)},${Math.round(rz * 1000)}`;
      const already = seen.get(key);
      if (already !== undefined) {
        mapped.push(already);
        return;
      }
      const at = cdtPoints.length;
      cdtPoints.push(ring.xz[k]);
      cdtToVertex.push(options.detachRoad ? addVertex(rx, world.terrain(rx, rz), rz) : v);
      seen.set(key, at);
      mapped.push(at);
    });
    for (let i = 0; i < mapped.length; i++) {
      const a = mapped[i];
      const b = mapped[(i + 1) % mapped.length];
      if (a !== b) cdtEdges.push([a, b]);
    }
  }

  const addGroundPoint = (x: number, z: number): void => {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return;
    if (rings.some((r) => pointInRing(r.xz, x, z))) return;
    if (world.shapes.some((s) => s.stations.some((st) => Math.hypot(st.x - x, st.z - z) < s.halfWidth + KEEP_CLEAR))) return;
    if (world.junctions.some((j) => Math.hypot(j.x - x, j.z - z) < KEEP_CLEAR * 4)) return;
    const key = `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
    if (seen.has(key)) return;
    seen.set(key, cdtPoints.length);
    cdtPoints.push([x, z]);
    cdtToVertex.push(addVertex(x, groundHeightAt(world, x, z), z));
  };

  // точки вдоль дороги: без них откос ложится на редкую сетку и выглядит рваным
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
      addGroundPoint(-WORLD_HALF + i * GRID_STEP, -WORLD_HALF + j * GRID_STEP);
    }
  }

  for (const tri of cdt2d(cdtPoints, cdtEdges, { delaunay: true, exterior: true, interior: true })) {
    const [a, b, c] = tri;
    const cx = (cdtPoints[a][0] + cdtPoints[b][0] + cdtPoints[c][0]) / 3;
    const cz = (cdtPoints[a][1] + cdtPoints[b][1] + cdtPoints[c][1]) / 3;
    if (rings.some((r) => pointInRing(r.xz, cx, cz))) continue;

    // Порядок обхода вершин решает, какой стороной треугольник смотрит.
    // Считаем его по самим точкам, а не предполагаем: тогда «изнанкой вверх»
    // становится невыразимым, а не отлавливаемым.
    const turn =
      (cdtPoints[b][0] - cdtPoints[a][0]) * (cdtPoints[c][1] - cdtPoints[a][1]) -
      (cdtPoints[b][1] - cdtPoints[a][1]) * (cdtPoints[c][0] - cdtPoints[a][0]);
    if (Math.abs(turn) < 1e-12) continue;
    if (turn > 0) byMaterial.grass.push(cdtToVertex[a], cdtToVertex[c], cdtToVertex[b]);
    else byMaterial.grass.push(cdtToVertex[a], cdtToVertex[b], cdtToVertex[c]);
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

/** Только полотно дороги, без земли — для предпросмотра при строительстве. */
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
