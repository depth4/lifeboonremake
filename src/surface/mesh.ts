/**
 * Сборка сетки треугольников и ЕДИНЫЙ РАСКРОЙ ПЛОСКОСТИ.
 *
 * Главная мысль: плоскость режется ОДИН раз. Границы всех областей — асфальта,
 * тротуара, разметки, края мира — идут в одну триангуляцию обязательными
 * рёбрами. Из чего сделан треугольник, решается ПОСЛЕ раскроя, по тому, куда
 * попал его центр.
 *
 * Отсюда главное следствие: «две соседние области разошлись на общей границе»
 * невыразимо. Границы не две — она одна, и обе области стоят на одних и тех же
 * точках. Раньше каждая область резалась отдельно, и щель между ними была
 * вопросом везения.
 *
 * Одна вершина = (место на плоскости + УРОВЕНЬ). Уровней два: проезжая часть
 * и полка тротуара. Соседние области на одном уровне делят вершины. Переход
 * между уровнями — это бордюр, и он рисуется стенкой.
 *
 * Порядок обхода треугольника нигде не задаётся руками: он вычисляется
 * из самих точек. Поэтому «треугольник смотрит изнанкой вверх» невозможно.
 */

import cdt2d from 'cdt2d';
import { incircle, orient2d } from 'robust-predicates';
import type { Point2 } from '../world/road.ts';
import type { Region } from './clip.ts';

export type Material = 'grass' | 'asphalt' | 'sidewalk' | 'marking' | 'curb';

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

/**
 * Уровень вершины: по нему решается, делят ли соседние области вершины.
 *
 * Общая вершина = плавный переход, разная вершина в том же месте = излом.
 * Поэтому бордюр держит СВОИ уровни: вдоль себя он гладкий, а с дорогой и
 * тротуаром сходится изломом — как настоящий бордюр и выглядит. Если бы он
 * делил вершины с ними, освещение размазало бы его в пологий скат, и узкий
 * тротуар потемнел бы целиком.
 *
 * Дырок это не создаёт: целость считается по МЕСТАМ рёбер, а не по номерам
 * вершин, и две вершины в одной точке для неё — одно и то же место.
 */
export const ROAD = 0;
export const SHELF = 1;
export const CURB_FOOT = 2;
export const CURB_TOP = 3;
export const GROUND = 4;
export const PAINT = 5;

/**
 * Из чего сложена ЗАМКНУТАЯ поверхность мира — та, сквозь которую не должно
 * быть видно неба. Разметка в неё не входит: это краска, лежащая на асфальте
 * сверху. Дырка в краске — не дырка в земле, и мерить их одной цифрой нельзя.
 */
export const SEALED: readonly Material[] = ['grass', 'asphalt', 'sidewalk', 'curb'];

const MATERIALS: Material[] = ['grass', 'asphalt', 'sidewalk', 'marking', 'curb'];

/**
 * Ключ места на плоскости с точностью до миллиметра, одним числом.
 * Строку тут собирать нельзя: вершин десятки тысяч, и склейка строк съедает
 * больше времени, чем вся триангуляция.
 */
const SPAN = 4_000_000;
const placeKey = (x: number, z: number, level: number): number =>
  ((Math.round(x * 1000) + 2_000_000) * SPAN + (Math.round(z * 1000) + 2_000_000)) * 8 + level;

export class MeshBuilder {
  private readonly xyz: number[] = [];
  private readonly byMaterial: Record<Material, number[]> =
    { grass: [], asphalt: [], sidewalk: [], marking: [], curb: [] };
  private readonly index = new Map<number, number>();

  vertex(x: number, y: number, z: number, level: number): number {
    const key = placeKey(x, z, level);
    const found = this.index.get(key);
    if (found !== undefined) return found;
    this.xyz.push(x, y, z);
    const at = this.xyz.length / 3 - 1;
    this.index.set(key, at);
    return at;
  }

  /** Вершина без общего учёта: для краски, которая ни с чем не сшивается. */
  loneVertex(x: number, y: number, z: number): number {
    this.xyz.push(x, y, z);
    return this.xyz.length / 3 - 1;
  }

  at(v: number): { x: number; y: number; z: number } {
    return { x: this.xyz[v * 3], y: this.xyz[v * 3 + 1], z: this.xyz[v * 3 + 2] };
  }

  tri(material: Material, a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) return;
    this.byMaterial[material].push(a, b, c);
  }

  /** Треугольник горизонтальной поверхности: разворачиваем лицом вверх. */
  triUp(material: Material, a: number, b: number, c: number): void {
    const pa = this.at(a), pb = this.at(b), pc = this.at(c);
    const turn = (pb.x - pa.x) * (pc.z - pa.z) - (pb.z - pa.z) * (pc.x - pa.x);
    if (Math.abs(turn) < 1e-12) return;
    if (turn < 0) this.tri(material, a, b, c);
    else this.tri(material, a, c, b);
  }

  /** Вертикальная стенка, развёрнутая лицом в сторону `awayFrom`. */
  wall(material: Material, lowA: number, lowB: number, highA: number, highB: number, awayFrom: Point2): void {
    const a = this.at(lowA), b = this.at(lowB);
    const mx = (a.x + b.x) / 2 - awayFrom.x;
    const mz = (a.z + b.z) / 2 - awayFrom.z;
    const outward = -(b.z - a.z) * mx + (b.x - a.x) * mz;
    if (outward > 0) {
      this.tri(material, lowA, highA, highB);
      this.tri(material, lowA, highB, lowB);
    } else {
      this.tri(material, lowA, highB, highA);
      this.tri(material, lowA, lowB, highB);
    }
  }

  build(): Surface {
    const indices: number[] = [];
    const groups: SurfaceGroup[] = [];
    for (const material of MATERIALS) {
      const list = this.byMaterial[material];
      if (list.length === 0) continue;
      groups.push({ material, start: indices.length, count: list.length });
      // по одному, а не россыпью: `push(...list)` кладёт КАЖДЫЙ элемент
      // отдельным доводом вызова и на сотне тысяч треугольников переполняет
      // стек. Мир вырастет — а это сломается молча и не там, где искать.
      for (const i of list) indices.push(i);
    }
    return {
      positions: new Float32Array(this.xyz),
      indices: new Uint32Array(indices),
      groups,
      stats: { vertices: this.xyz.length / 3, triangles: indices.length / 3 },
    };
  }
}

/** Треугольник раскроя: три точки и центр, по которому решается материал. */
export interface Face {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly x: number;
  readonly z: number;
}

export interface Plane {
  readonly points: readonly Point2[];
  readonly faces: readonly Face[];
}

/** Сетка отрезков: чтобы быстро спрашивать «далеко ли отсюда до ближайшей границы». */
class SegmentGrid {
  private readonly cell: number;
  private readonly buckets = new Map<string, number[][]>();

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(i: number, j: number): string {
    return `${i},${j}`;
  }

  add(ax: number, az: number, bx: number, bz: number, pad: number): void {
    const i0 = Math.floor((Math.min(ax, bx) - pad) / this.cell);
    const i1 = Math.floor((Math.max(ax, bx) + pad) / this.cell);
    const j0 = Math.floor((Math.min(az, bz) - pad) / this.cell);
    const j1 = Math.floor((Math.max(az, bz) + pad) / this.cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        const list = this.buckets.get(k);
        if (list) list.push([ax, az, bx, bz]);
        else this.buckets.set(k, [[ax, az, bx, bz]]);
      }
    }
  }

  /** Есть ли граница ближе, чем `limit`, к этой точке. */
  crowded(x: number, z: number, limit: number): boolean {
    const list = this.buckets.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!list) return false;
    const limitSq = limit * limit;
    for (const [ax, az, bx, bz] of list) {
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (ax + dx * t), ez = z - (az + dz * t);
      if (ex * ex + ez * ez < limitSq) return true;
    }
    return false;
  }
}

/**
 * Режет плоскость один раз.
 *
 * `borders` — контуры, которые обязаны остаться границами треугольников.
 * `interior` — точки, которые хочется иметь внутри, чтобы поверхность повторяла
 * рельеф. Точку, севшую слишком близко к границе, раскрой не берёт: тонкий
 * треугольник у края — это игла, которая рвёт освещение.
 */
export function carvePlane(
  borders: readonly Region[],
  interior: readonly Point2[],
  clearance: number,
): Plane {
  const points: number[][] = [];
  const edges: number[][] = [];
  const seen = new Map<number, number>();
  const put = (p: Point2): number => {
    const key = placeKey(p.x, p.z, 0);
    const found = seen.get(key);
    if (found !== undefined) return found;
    const at = points.length;
    points.push([p.x, p.z]);
    seen.set(key, at);
    return at;
  };

  const grid = new SegmentGrid(Math.max(4, clearance * 2));
  for (const region of borders) {
    for (const ring of region) {
      if (ring.length < 3) continue;
      const mapped = ring.map(put);
      for (let i = 0; i < mapped.length; i++) {
        const a = mapped[i], b = mapped[(i + 1) % mapped.length];
        if (a === b) continue;
        edges.push([a, b]);
        grid.add(points[a][0], points[a][1], points[b][0], points[b][1], clearance);
      }
    }
  }

  for (const p of interior) {
    if (grid.crowded(p.x, p.z, clearance)) continue;
    const before = points.length;
    const at = put(p);
    // точка, совпавшая с уже поставленной, — не новая точка
    if (at < before) continue;
    grid.add(p.x, p.z, p.x, p.z, clearance);
  }

  // Триангуляция в два приёма. Библиотека умеет и сразу «красиво», но её
  // красивый режим на десяти тысячах точек думает четыре секунды, а тупой —
  // двадцать миллисекунд. Поэтому режем тупо, а качество наводим сами.
  const raw = cdt2d(points, edges, { delaunay: false, exterior: true, interior: true });
  const tri = new Int32Array(raw.length * 3);
  for (let t = 0; t < raw.length; t++) {
    const [a, b, c] = raw[t];
    // все треугольники обходим в одну сторону: иначе «сосед через ребро»
    // перестаёт быть однозначным понятием
    const ccw = orient2d(points[a][0], points[a][1], points[b][0], points[b][1], points[c][0], points[c][1]) < 0;
    tri[t * 3] = a;
    tri[t * 3 + 1] = ccw ? b : c;
    tri[t * 3 + 2] = ccw ? c : b;
  }
  makeDelaunay(points, tri, edges);

  const faces: Face[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    faces.push({
      a, b, c,
      x: (points[a][0] + points[b][0] + points[c][0]) / 3,
      z: (points[a][1] + points[b][1] + points[c][1]) / 3,
    });
  }
  return { points: points.map(([x, z]) => ({ x, z })), faces };
}

const nextEdge = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1);
const prevEdge = (e: number): number => (e % 3 === 0 ? e + 2 : e - 1);

/**
 * Наводит качество: пока найдётся ребро, у которого чужая вершина попадает
 * внутрь описанной окружности соседа, — переворачиваем это ребро.
 *
 * Это классический перещёлк Лоусона. Он не двигает ни одной точки и не меняет
 * границ: обязательные рёбра не трогаются вовсе, а переворот делается только
 * если оба новых треугольника вышли лицом вверх. Поэтому испортить раскрой
 * им нельзя — только улучшить форму треугольников.
 */
function makeDelaunay(points: number[][], tri: Int32Array, edges: number[][]): void {
  const n = tri.length;
  const twin = new Int32Array(n).fill(-1);
  const seen = new Map<number, number>();
  const V = points.length;
  for (let e = 0; e < n; e++) {
    const a = tri[e], b = tri[nextEdge(e)];
    const back = seen.get(b * V + a);
    if (back !== undefined) {
      twin[e] = back;
      twin[back] = e;
      seen.delete(b * V + a);
    } else {
      seen.set(a * V + b, e);
    }
  }

  const locked = new Set<number>();
  for (const [a, b] of edges) locked.add(a < b ? a * V + b : b * V + a);
  const isLocked = (a: number, b: number): boolean => locked.has(a < b ? a * V + b : b * V + a);

  // «Уже в очереди» отмечается ТОЛЬКО при укладке в стопку. Если пометить
  // всё сразу, то полуребро на краю мира (у которого соседа нет и в стопку
  // оно не легло) навсегда считалось бы просмотренным — а после переворота
  // сосед у него появляется, и проверить его уже никто не придёт.
  const stack: number[] = [];
  const queued = new Uint8Array(n);
  for (let e = 0; e < n; e++) {
    if (twin[e] < 0) continue;
    stack.push(e);
    queued[e] = 1;
  }

  let guard = n * 40;
  while (stack.length > 0 && guard-- > 0) {
    const e = stack.pop() as number;
    queued[e] = 0;
    const t = twin[e];
    if (t < 0) continue;

    const a = tri[e], b = tri[nextEdge(e)];
    if (isLocked(a, b)) continue;
    const p = tri[prevEdge(e)];
    const q = tri[prevEdge(t)];

    const pa = points[a], pb = points[b], pp = points[p], pq = points[q];
    // Треугольник нулевой площади — не треугольник, и он всегда неправильный.
    // Отдельно потому, что описанной окружности у него нет и обычная проверка
    // о нём ничего сказать не может. Такие рождаются там, где три точки лежат
    // ровно на одной прямой: например вдоль края мира.
    const flat =
      orient2d(pa[0], pa[1], pb[0], pb[1], pp[0], pp[1]) === 0 ||
      orient2d(pb[0], pb[1], pa[0], pa[1], pq[0], pq[1]) === 0;
    // чужая вершина внутри описанной окружности — ребро лежит неправильно
    if (!flat && incircle(pa[0], pa[1], pb[0], pb[1], pp[0], pp[1], pq[0], pq[1]) <= 0) continue;
    // после переворота получатся треугольники (q,b,p) и (p,a,q). Переворот
    // делается, только если оба вышли обходом в ту же сторону, что и все
    // остальные: вывернутый треугольник так становится невозможен
    if (orient2d(pq[0], pq[1], pb[0], pb[1], pp[0], pp[1]) >= 0) continue;
    if (orient2d(pp[0], pp[1], pa[0], pa[1], pq[0], pq[1]) >= 0) continue;

    const en = nextEdge(e), ep = prevEdge(e);
    const tn = nextEdge(t), tp = prevEdge(t);
    const outsideEp = twin[ep], outsideTp = twin[tp];

    tri[e] = q;
    tri[t] = p;

    const link = (x: number, y: number): void => {
      twin[x] = y;
      if (y >= 0) twin[y] = x;
    };
    link(e, outsideTp);
    link(t, outsideEp);
    link(ep, tp);

    for (const side of [e, t, en, ep, tn, tp]) {
      if (twin[side] >= 0 && queued[side] === 0) {
        queued[side] = 1;
        stack.push(side);
      }
    }
 }
}
