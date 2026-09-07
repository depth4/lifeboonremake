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

/** Уровень вершины: по нему решается, делят ли соседние области вершины. */
export const ROAD = 0;
export const SHELF = 1;

const MATERIALS: Material[] = ['grass', 'asphalt', 'sidewalk', 'marking', 'curb'];

export class MeshBuilder {
  private readonly xyz: number[] = [];
  private readonly byMaterial: Record<Material, number[]> =
    { grass: [], asphalt: [], sidewalk: [], marking: [], curb: [] };
  private readonly index = new Map<string, number>();

  vertex(x: number, y: number, z: number, level: number): number {
    const key = `${Math.round(x * 1000)},${Math.round(z * 1000)},${level}`;
    const found = this.index.get(key);
    if (found !== undefined) return found;
    this.xyz.push(x, y, z);
    const at = this.xyz.length / 3 - 1;
    this.index.set(key, at);
    return at;
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
      indices.push(...list);
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
  const seen = new Map<string, number>();
  const put = (p: Point2): number => {
    const key = `${Math.round(p.x * 1000)},${Math.round(p.z * 1000)}`;
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

  const faces: Face[] = [];
  for (const [a, b, c] of cdt2d(points, edges, { delaunay: true, exterior: true, interior: true })) {
    faces.push({
      a, b, c,
      x: (points[a][0] + points[b][0] + points[c][0]) / 3,
      z: (points[a][1] + points[b][1] + points[c][1]) / 3,
    });
  }
  return { points: points.map(([x, z]) => ({ x, z })), faces };
}
