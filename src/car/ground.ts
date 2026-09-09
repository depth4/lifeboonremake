/**
 * Опора под колесом: высота, наклон и покрытие.
 *
 * ГЛАВНОЕ: ответы берутся из ТЕХ ЖЕ треугольников, которые нарисованы на
 * экране. Не из отдельной «физической» земли, не из повторного счёта высоты
 * по формуле. Из-за этого «колесо провалилось под асфальт» невозможно
 * записать: колесо стоит ровно на том треугольнике, который видит игрок.
 *
 * Это прямое продолжение решения 008: одна поверхность, а не две.
 */

import type { Material, Surface } from '../surface/index.ts';
import { SEALED } from '../surface/index.ts';

export interface Spot {
  /** Высота поверхности в этой точке, м. */
  readonly height: number;
  /** Нормаль — куда смотрит поверхность. Единичная. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Из чего сделано место: асфальт, трава, бордюр... */
  readonly material: Material;
}

const CELL = 6; // м, сторона клетки поискового ящика

/** Пусто под колесом — так бывает только за краем мира. */
const VOID: Spot = { height: -1e4, nx: 0, ny: 1, nz: 0, material: 'grass' };

export class GroundIndex {
  private readonly pos: Float32Array;
  private readonly idx: Uint32Array;
  /** На каком треугольнике какое покрытие. */
  private readonly mat: Uint8Array;
  private readonly names: Material[];
  private readonly cells = new Map<number, number[]>();
  private minX = 0;
  private minZ = 0;
  private cols = 1;

  constructor(surface: Surface) {
    this.pos = surface.positions;
    this.idx = surface.indices;
    const tris = surface.indices.length / 3;
    this.mat = new Uint8Array(tris);
    this.names = [];

    for (const group of surface.groups) {
      let code = this.names.indexOf(group.material);
      if (code < 0) { code = this.names.length; this.names.push(group.material); }
      for (let k = group.start; k < group.start + group.count; k += 3) this.mat[k / 3] = code;
    }

    // границы мира по вершинам
    let maxX = -Infinity, maxZ = -Infinity;
    this.minX = Infinity; this.minZ = Infinity;
    for (let v = 0; v < this.pos.length; v += 3) {
      if (this.pos[v] < this.minX) this.minX = this.pos[v];
      if (this.pos[v] > maxX) maxX = this.pos[v];
      if (this.pos[v + 2] < this.minZ) this.minZ = this.pos[v + 2];
      if (this.pos[v + 2] > maxZ) maxZ = this.pos[v + 2];
    }
    this.cols = Math.max(1, Math.ceil((maxX - this.minX) / CELL) + 1);

    for (let t = 0; t < tris; t++) {
      const a = this.idx[t * 3] * 3, b = this.idx[t * 3 + 1] * 3, c = this.idx[t * 3 + 2] * 3;
      const x0 = Math.min(this.pos[a], this.pos[b], this.pos[c]);
      const x1 = Math.max(this.pos[a], this.pos[b], this.pos[c]);
      const z0 = Math.min(this.pos[a + 2], this.pos[b + 2], this.pos[c + 2]);
      const z1 = Math.max(this.pos[a + 2], this.pos[b + 2], this.pos[c + 2]);
      for (let cx = this.col(x0); cx <= this.col(x1); cx++)
        for (let cz = this.row(z0); cz <= this.row(z1); cz++) {
          const key = cz * this.cols + cx;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(t); else this.cells.set(key, [t]);
        }
    }
  }

  private col(x: number): number { return Math.floor((x - this.minX) / CELL); }
  private row(z: number): number { return Math.floor((z - this.minZ) / CELL); }

  /**
   * Что под точкой. Краска (разметка) лежит на два сантиметра выше асфальта
   * и опорой не считается — она красит покрытие, но не держит колесо.
   * Иначе машина подпрыгивала бы на каждой полосе разметки.
   */
  sample(x: number, z: number): Spot {
    const bucket = this.cells.get(this.row(z) * this.cols + this.col(x));
    if (!bucket) return VOID;

    let best: Spot | null = null;
    let paint = false;
    for (const t of bucket) {
      const hit = this.hitTriangle(t, x, z);
      if (hit === null) continue;
      const material = this.names[this.mat[t]];
      if (!SEALED.includes(material)) { paint = true; continue; }
      if (best === null || hit.height > best.height) best = { ...hit, material };
    }
    if (best === null) return VOID;
    return paint ? { ...best, material: 'marking' } : best;
  }

  /** Высота и нормаль треугольника в точке — или null, если точка мимо. */
  private hitTriangle(t: number, x: number, z: number): Omit<Spot, 'material'> | null {
    const p = this.pos;
    const a = this.idx[t * 3] * 3, b = this.idx[t * 3 + 1] * 3, c = this.idx[t * 3 + 2] * 3;
    const ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[c], cz = p[c + 2];

    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) return null;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) return null;

    const height = u * p[a + 1] + v * p[b + 1] + w * p[c + 1];
    // нормаль самого треугольника — значит наклон настоящий, а не сглаженный
    const e1x = bx - ax, e1y = p[b + 1] - p[a + 1], e1z = bz - az;
    const e2x = cx - ax, e2y = p[c + 1] - p[a + 1], e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    return { height, nx, ny, nz };
  }
}
