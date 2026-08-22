/**
 * Превращает мир в ОДНУ поверхность.
 *
 * Три разных объекта, у каждого свои правила:
 *   — проезжая часть: полосы вдоль осевой линии;
 *   — тротуар: идёт СНАРУЖИ проезжей части и огибает перекрёсток дугой;
 *   — площадка перекрёстка: скруглённая, собрана из торцов подрезанных дорог.
 *
 * Тротуар нарочно не входит в ширину дороги. Пока он был внутри, на остром
 * угле он упирался в соседнюю дорогу, и постройка срывалась. Снаружи ему
 * упираться не во что: он просто обходит угол.
 *
 * Всё это — части одной сетки треугольников с общими вершинами, поэтому
 * «земля торчит сквозь дорогу» здесь невыразимо.
 *
 * Про Three.js этот файл не знает ничего — он выдаёт просто числа.
 */

import cdt2d from 'cdt2d';
import type { LaneKind, Station } from './world/road.ts';
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
  marking: 'marking',
  median: 'median',
};

/** Шаг сетки земли, метры. */
const GRID_STEP = 3;
/** Насколько близко к дороге сетке земли подходить нельзя. */
const KEEP_CLEAR = 1.5;
/** На каких расстояниях от края дороги ставим точки вдоль откоса, метры. */
const SLOPE_RINGS = [1.8, 4.5, 8.5, 14, 22];
/** За сколько станций бордюр сходит на нет у свободного торца. */
const CURB_TAPER = 3;
/** На сколько звеньев разбивается скруглённый угол перекрёстка. */
const CORNER_STEPS = 5;

type AddVertex = (x: number, y: number, z: number) => number;
type AddQuad = (material: Material, a: number, b: number, c: number, d: number) => void;
type AddTri = (material: Material, a: number, b: number, c: number) => void;

/** Торец дороги: поперечник от внешнего края тротуара до внешнего края. */
interface Cap {
  /** внешний угол тротуара со стороны -полуширины */
  readonly walkMinus: number;
  /** верх бордюра со стороны -полуширины */
  readonly kerbMinus: number;
  /** поперечник проезжей части по низу, от -полуширины к +полуширине */
  readonly cross: number[];
  readonly kerbPlus: number;
  readonly walkPlus: number;
}

interface Strips {
  readonly ring: number[];
  readonly caps: readonly [Cap, Cap];
}

/** Пересекаются ли отрезки строго внутри себя. Габариты — чтобы не ловить шум. */
function segmentsCross(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  // касание общим концом — не пересечение: соседние контуры делят вершины
  const same = (p: number[], q: number[]): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.02;
  if (same(a1, b1) || same(a1, b2) || same(a2, b1) || same(a2, b2)) return false;

  if (Math.min(a1[0], a2[0]) > Math.max(b1[0], b2[0])) return false;
  if (Math.max(a1[0], a2[0]) < Math.min(b1[0], b2[0])) return false;
  if (Math.min(a1[1], a2[1]) > Math.max(b1[1], b2[1])) return false;
  if (Math.max(a1[1], a2[1]) < Math.min(b1[1], b2[1])) return false;
  const side = (p: number[], q: number[], r: number[]): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const eps = 1e-6;
  const opposite = (u: number, v: number): boolean => (u > eps && v < -eps) || (u < -eps && v > eps);
  return opposite(side(a1, a2, b1), side(a1, a2, b2)) && opposite(side(b1, b2, a1), side(b1, b2, a2));
}

/**
 * Последняя страховка: контуры обязаны быть простыми и не накладываться.
 * Это НЕ способ переложить работу на игрока — привязка и вынесенный наружу
 * тротуар делают наложение редким. Но если оно всё же случилось, показать
 * рваную землю хуже, чем честно сказать «так не получится».
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
            const f = (q: number[]): string => `[${q[0].toFixed(1)},${q[1].toFixed(1)}]`;
            return `${a === b ? 'сам себя: контур ' + a : 'контуры ' + a + ' и ' + b}: ${f(segs[a][i][0])}→${f(segs[a][i][1])} против ${f(segs[b][j][0])}→${f(segs[b][j][1])}`;
          }
        }
      }
    }
  }
  for (let a = 0; a < rings.length; a++) {
    for (let b = 0; b < rings.length; b++) {
      if (a === b) continue;
      let inside = 0;
      for (const p of rings[a].xz) if (pointInRing(rings[b].xz, p[0], p[1])) inside++;
      if (inside * 2 > rings[a].xz.length) return `контур ${a} внутри контура ${b}`;
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
 * Полотно дороги: проезжая часть, бордюры и тротуары по бокам.
 * У торца, упирающегося в перекрёсток, бордюр не сходит на нет — там он
 * продолжается в бордюр перекрёстка. У свободного торца сходит, иначе
 * поперечник стал бы ступенькой и землю к нему пришить было бы нельзя.
 */
function roadStrips(shape: RoadShape, addVertex: AddVertex, addQuad: AddQuad, addTri: AddTri): Strips | null {
  const band = bands(shape.type);
  const n = shape.stations.length - 1;
  if (band.length === 0 || n < 1) return null;

  const walk = shape.type.sidewalk;
  const curb = shape.type.curb;
  const cw = shape.halfWidth;

  const taper = (i: number): number => {
    const fromStart = shape.startJoined ? 1 : Math.min(1, i / CURB_TAPER);
    const fromEnd = shape.endJoined ? 1 : Math.min(1, (n - i) / CURB_TAPER);
    return Math.min(fromStart, fromEnd);
  };

  const at = (i: number, offset: number, rise: number): number => {
    const st: Station = shape.stations[i];
    return addVertex(st.x + st.nx * offset, shape.height[i] + rise * taper(i), st.z + st.nz * offset);
  };

  // --- проезжая часть ---
  const crossAt: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[] = [];
    band.forEach((b, k) => {
      const sameAsPrev = k > 0 && (band[k - 1].rise === b.rise || taper(i) === 0);
      row.push(sameAsPrev ? row[row.length - 1] : at(i, b.from, b.rise));
      row.push(at(i, b.to, b.rise));
    });
    crossAt.push(row);
  }

  for (let i = 0; i < n; i++) {
    band.forEach((b, k) => {
      const l0 = crossAt[i][k * 2], r0 = crossAt[i][k * 2 + 1];
      const l1 = crossAt[i + 1][k * 2], r1 = crossAt[i + 1][k * 2 + 1];
      addQuad(MATERIAL_OF[b.kind], l0, r0, r1, l1);
      if (k > 0 && band[k - 1].rise !== b.rise) {
        curbWall(i, b.from, band[k - 1].rise, b.rise);
      }
    });
  }

  /** Вертикальная стенка на изломе высот. Свои вершины — иначе ребро размажется. */
  function curbWall(i: number, offset: number, lowRise: number, highRise: number): void {
    const corner = (m: number): { low: number; high: number } => {
      if (taper(m) === 0) {
        const shared = at(m, offset, 0);
        return { low: shared, high: shared };
      }
      return { low: at(m, offset, lowRise), high: at(m, offset, highRise) };
    };
    const a = corner(i);
    const c = corner(i + 1);
    if (a.low === a.high) addTri('curb', a.low, c.high, c.low);
    else if (c.low === c.high) addTri('curb', a.low, a.high, c.low);
    else addQuad('curb', a.low, a.high, c.high, c.low);
  }

  // --- тротуары: отдельный объект снаружи проезжей части ---
  const outerMinus: number[] = [];
  const outerPlus: number[] = [];
  const innerMinus: number[] = [];
  const innerPlus: number[] = [];

  for (let i = 0; i <= n; i++) {
    innerMinus.push(at(i, -cw, curb));
    innerPlus.push(at(i, cw, curb));
    outerMinus.push(at(i, -(cw + walk), curb));
    outerPlus.push(at(i, cw + walk, curb));
  }

  if (walk > 0) {
    for (let i = 0; i < n; i++) {
      addQuad('sidewalk', outerMinus[i], innerMinus[i], innerMinus[i + 1], outerMinus[i + 1]);
      addQuad('sidewalk', innerPlus[i], outerPlus[i], outerPlus[i + 1], innerPlus[i + 1]);
      curbWall(i, -cw, 0, curb);
      curbWall(i, cw, 0, curb);
    }
  }

  const capAt = (i: number): Cap => ({
    walkMinus: outerMinus[i],
    kerbMinus: innerMinus[i],
    cross: crossAt[i].filter((v, k) => k === 0 || v !== crossAt[i][k - 1]),
    kerbPlus: innerPlus[i],
    walkPlus: outerPlus[i],
  });

  const ring: number[] = [];
  for (let i = 0; i <= n; i++) ring.push(outerMinus[i]);
  const endCap = capAt(n);
  ring.push(...endCap.cross, endCap.walkPlus);
  for (let i = n - 1; i >= 0; i--) ring.push(outerPlus[i]);
  const startCap = capAt(0);
  ring.push(...[...startCap.cross].reverse());

  return { ring: dedupe(ring), caps: [startCap, endCap] };
}

function dedupe(list: number[]): number[] {
  const out: number[] = [];
  for (const v of list) if (v !== out[out.length - 1]) out.push(v);
  if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

export interface SurfaceOptions {
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
    if (a !== b && b !== c && a !== c) byMaterial[m].push(a, b, c);
  };
  const addQuad: AddQuad = (m, a, b, c, d) => {
    addTri(m, a, b, c);
    addTri(m, a, c, d);
  };
  const px = (v: number): number => positions[v * 3];
  const pz = (v: number): number => positions[v * 3 + 2];

  /** Треугольник горизонтальной поверхности: порядок обхода считаем, не задаём. */
  const addTriUp: AddTri = (m, a, b, c) => {
    const turn = (px(b) - px(a)) * (pz(c) - pz(a)) - (pz(b) - pz(a)) * (px(c) - px(a));
    if (Math.abs(turn) < 1e-9) return;
    if (turn < 0) addTri(m, a, b, c);
    else addTri(m, a, c, b);
  };
  const addQuadUp: AddQuad = (m, a, b, c, d) => {
    addTriUp(m, a, b, c);
    addTriUp(m, a, c, d);
  };
  /**
   * Вертикальная стенка бордюра, развёрнутая лицом ОТ точки `awayFrom`.
   * Сторону считаем по точкам, а не задаём — иначе половина бордюров
   * оказалась бы изнанкой наружу.
   */
  const addWall = (lowA: number, highA: number, highB: number, lowB: number, awayX: number, awayZ: number): void => {
    const mx = (px(lowA) + px(lowB)) / 2 - awayX;
    const mz = (pz(lowA) + pz(lowB)) / 2 - awayZ;
    // нормаль стенки в плане перпендикулярна её основанию
    const bx = px(lowB) - px(lowA);
    const bz = pz(lowB) - pz(lowA);
    const outward = (-bz) * mx + bx * mz;
    if (outward > 0) {
      addTri('curb', lowA, highA, highB);
      addTri('curb', lowA, highB, lowB);
    } else {
      addTri('curb', lowA, highB, highA);
      addTri('curb', lowA, lowB, highB);
    }
  };

  const rings: { indices: number[]; xz: number[][] }[] = [];
  const strips = world.shapes.map((shape) => roadStrips(shape, addVertex, addQuad, addTri));
  for (const s of strips) {
    if (s) rings.push({ indices: s.ring, xz: s.ring.map((v) => [px(v), pz(v)]) });
  }

  // --- перекрёсток: скруглённые углы, тротуар огибает их дугой ---
  for (const junction of world.junctions) {
    const ends = junction.ends.map((end) => {
      const s = strips[end.shape];
      if (!s) return null;
      const cap = s.caps[end.atStart ? 0 : 1];
      const flip = !end.atStart;
      return {
        cross: flip ? [...cap.cross].reverse() : cap.cross,
        kerbFirst: flip ? cap.kerbPlus : cap.kerbMinus,
        kerbLast: flip ? cap.kerbMinus : cap.kerbPlus,
        walkFirst: flip ? cap.walkPlus : cap.walkMinus,
        walkLast: flip ? cap.walkMinus : cap.walkPlus,
        curb: world.shapes[end.shape].type.curb,
      };
    });
    if (ends.some((e) => e === null) || ends.length < 2) continue;

    /** Углы и радиусы для скруглённого угла: одни и те же для всех трёх дуг. */
    const sweep = (from: number, to: number): { angle: number; t: number }[] => {
      const a0 = Math.atan2(pz(from) - junction.z, px(from) - junction.x);
      let a1 = Math.atan2(pz(to) - junction.z, px(to) - junction.x);
      while (a1 <= a0) a1 += Math.PI * 2;
      const out: { angle: number; t: number }[] = [];
      for (let k = 1; k < CORNER_STEPS; k++) {
        const t = k / CORNER_STEPS;
        out.push({ angle: a0 + (a1 - a0) * t, t });
      }
      return out;
    };
    /**
     * Дуга ПОСТОЯННОГО радиуса, равного большему из двух углов торцов.
     * Радиус нарочно не интерполируется: интерполяция подныривала под кромку
     * соседней дороги, и контуры пересекались. Постоянный радиус всегда снаружи.
     */
    const along = (from: number, to: number, steps: { angle: number; t: number }[], y: number): number[] => {
      const r = Math.max(
        Math.hypot(px(from) - junction.x, pz(from) - junction.z),
        Math.hypot(px(to) - junction.x, pz(to) - junction.z),
      );
      return steps.map(({ angle }) =>
        addVertex(junction.x + Math.cos(angle) * r, y, junction.z + Math.sin(angle) * r));
    };

    const plaza: number[] = [];
    const outerLoop: number[] = [];
    const middle = addVertex(junction.x, junction.height, junction.z);
    const top = junction.height + ends[0]!.curb;

    ends.forEach((raw, i) => {
      const cur = raw!;
      const next = ends[(i + 1) % ends.length]!;
      const tailLow = cur.cross[cur.cross.length - 1];
      const headLow = next.cross[0];

      plaza.push(...cur.cross);
      outerLoop.push(cur.walkFirst, ...cur.cross, cur.walkLast);

      const steps = sweep(tailLow, headLow);
      const low = along(tailLow, headLow, steps, junction.height);
      const high = along(cur.kerbLast, next.kerbFirst, steps, top);
      const outer = along(cur.walkLast, next.walkFirst, steps, top);

      plaza.push(...low);
      outerLoop.push(...outer);

      const chainLow = [tailLow, ...low, headLow];
      const chainHigh = [cur.kerbLast, ...high, next.kerbFirst];
      const chainOuter = [cur.walkLast, ...outer, next.walkFirst];

      for (let k = 0; k + 1 < chainLow.length; k++) {
        // тротуар угла — плоская полоса на высоте бордюра
        addQuadUp('sidewalk', chainHigh[k], chainOuter[k], chainOuter[k + 1], chainHigh[k + 1]);
        // бордюр — вертикальная стенка, смотрит наружу от центра перекрёстка
        addWall(chainLow[k], chainHigh[k], chainHigh[k + 1], chainLow[k + 1], junction.x, junction.z);
      }
    });

    const loop = dedupe(plaza);
    for (let i = 0; i < loop.length; i++) {
      addTriUp('asphalt', middle, loop[i], loop[(i + 1) % loop.length]);
    }

    const outerRing = dedupe(outerLoop);
    if (outerRing.length >= 3) rings.push({ indices: outerRing, xz: outerRing.map((v) => [px(v), pz(v)]) });
  }

  const unsound = process.env?.SKIP_SOUND ? null : ringsAreSound(rings);
  if (unsound !== null) throw new Error('дороги накладываются друг на друга — ' + unsound);

  // --- земля ---
  const cdtPoints: number[][] = [];
  const cdtToVertex: number[] = [];
  const cdtEdges: number[][] = [];
  const seen = new Map<string, number>();
  const keyOf = (x: number, z: number): string => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;

  for (const ring of rings) {
    const mapped: number[] = [];
    ring.indices.forEach((v, k) => {
      const [rx, rz] = ring.xz[k];
      const key = keyOf(rx, rz);
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
    if (world.shapes.some((s) => s.stations.some((st) => Math.hypot(st.x - x, st.z - z) < s.outerHalf + KEEP_CLEAR))) return;
    if (world.junctions.some((j) => Math.hypot(j.x - x, j.z - z) < KEEP_CLEAR * 5)) return;
    const key = keyOf(x, z);
    if (seen.has(key)) return;
    seen.set(key, cdtPoints.length);
    cdtPoints.push([x, z]);
    cdtToVertex.push(addVertex(x, groundHeightAt(world, x, z), z));
  };

  for (const shape of world.shapes) {
    for (let i = 0; i < shape.stations.length; i += 2) {
      const st = shape.stations[i];
      for (const away of SLOPE_RINGS) {
        for (const side of [1, -1]) {
          const off = side * (shape.outerHalf + away);
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

    // Порядок обхода считаем по точкам, а не задаём: «изнанкой вверх» невыразимо.
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
  const addTri: AddTri = (_m, a, b, c) => {
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  };
  const addQuad: AddQuad = (m, a, b, c, d) => {
    addTri(m, a, b, c);
    addTri(m, a, c, d);
  };
  roadStrips(shape, addVertex, addQuad, addTri);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
