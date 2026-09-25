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

/** Дальше этого луч курсора землю не ищет, м: мир — плита в 1.2 км. */
const ДАЛЬ_ЛУЧА = 3000;

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
  /** Слой высот мира: вне его луч землю встретить не может. */
  private низ = Infinity;
  private верх = -Infinity;

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
      if (this.pos[v + 1] < this.низ) this.низ = this.pos[v + 1];
      if (this.pos[v + 1] > this.верх) this.верх = this.pos[v + 1];
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

  /**
   * Где луч из (o) по направлению (d) впервые уходит под землю. Нужно
   * курсору строителя: «куда на земле я показываю».
   *
   * До 25.09 это искал луч three.js по ВСЕМ треугольникам нарисованной
   * земли: 16 мс на «городе» и 57 мс на «большом» на одно движение мыши.
   * Здесь луч идёт шагами не длиннее метра и на каждом спрашивает высоту
   * там же, где её спрашивает колесо, — у своей клетки ящика. Земля та же
   * самая: курсор, колесо и нога не могут разойтись во мнении, где она.
   */
  луч(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): { x: number; z: number } | null {
    const над = (t: number): number => oy + dy * t - this.sample(ox + dx * t, oz + dz * t).height;
    // луч вне слоя высот мира землю не встретит: и начало, и конец берутся из слоя
    let t0 = 0, t1 = ДАЛЬ_ЛУЧА;
    if (dy < 0) {
      t0 = Math.max(0, (oy - this.верх) / -dy);
      t1 = Math.min(t1, (oy - this.низ) / -dy);
    } else if (oy > this.верх) return null;
    // шаг: не больше метра вдоль земли и полуметра по высоте
    const шаг = Math.min(1 / Math.max(1e-9, Math.hypot(dx, dz)), 0.5 / Math.max(1e-9, Math.abs(dy)));
    let до = t0;
    if (над(до) <= 0) return { x: ox + dx * до, z: oz + dz * до };
    for (let t = t0 + шаг; t <= t1 + шаг; t += шаг) {
      if (над(t) > 0) { до = t; continue; }
      // перешли под землю между «до» и t — делим отрезок пополам до сантиметра
      let под = t;
      while ((под - до) * Math.hypot(dx, dy, dz) > 0.01) {
        const м = (до + под) / 2;
        if (над(м) > 0) до = м; else под = м;
      }
      return { x: ox + dx * под, z: oz + dz * под };
    }
    return null;
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
