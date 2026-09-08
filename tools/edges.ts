/**
 * Пересекаются ли обязательные рёбра раскроя.
 *
 * Если два обязательных ребра пересекаются, триангуляция не может выполнить
 * оба и выдаёт налезающие друг на друга треугольники — а это ровно то, что
 * потом выглядит как незашитые рёбра. Инвариант простой: границы областей
 * не пересекаются, потому что области вложены друг в друга.
 */

import type { Point2 } from '../src/world/road.ts';
import type { Region } from '../src/surface/clip.ts';
import type { World } from '../src/world/world.ts';
import { plan } from '../src/surface/carve.ts';
import { densify } from '../src/surface/clip.ts';


interface Seg { a: Point2; b: Point2; who: string }

const same = (u: Point2, v: Point2): boolean => Math.abs(u.x - v.x) < 1e-9 && Math.abs(u.z - v.z) < 1e-9;

/** Строго пересекаются, не считая общих концов. */
function cross(s: Seg, t: Seg): Point2 | null {
  if (same(s.a, t.a) || same(s.a, t.b) || same(s.b, t.a) || same(s.b, t.b)) return null;
  const ax = s.b.x - s.a.x, az = s.b.z - s.a.z;
  const bx = t.b.x - t.a.x, bz = t.b.z - t.a.z;
  const den = ax * bz - az * bx;
  if (Math.abs(den) < 1e-12) return null;
  const u = ((t.a.x - s.a.x) * bz - (t.a.z - s.a.z) * bx) / den;
  const v = ((t.a.x - s.a.x) * az - (t.a.z - s.a.z) * ax) / den;
  if (u <= 1e-9 || u >= 1 - 1e-9 || v <= 1e-9 || v >= 1 - 1e-9) return null;
  return { x: s.a.x + ax * u, z: s.a.z + az * u };
}

/** Сколько обязательных рёбер пересекается и где — первые несколько. */
export function crossingBorders(world: World): { count: number; where: string[] } {
  const p = plan(world);
  const segs: Seg[] = [];
  const collect = (region: Region, who: string): void => {
    for (const ring of densify(region, 4)) {
      for (let i = 0; i < ring.length; i++) segs.push({ a: ring[i], b: ring[(i + 1) % ring.length], who });
    }
  };
  collect(p.paved, 'асфальт');
  collect(p.outer, 'тротуар');

  const CELL = 8;
  const cells = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const i0 = Math.floor(Math.min(s.a.x, s.b.x) / CELL), i1 = Math.floor(Math.max(s.a.x, s.b.x) / CELL);
    const j0 = Math.floor(Math.min(s.a.z, s.b.z) / CELL), j1 = Math.floor(Math.max(s.a.z, s.b.z) / CELL);
    for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) {
      const k = `${ii},${jj}`;
      const list = cells.get(k);
      if (list) list.push(i); else cells.set(k, [i]);
    }
  });

  let count = 0;
  const where: string[] = [];
  const seen = new Set<string>();
  for (const list of cells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const key = `${list[a]}:${list[b]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = cross(segs[list[a]], segs[list[b]]);
        if (!hit) continue;
        count++;
        if (where.length < 6) {
          where.push(`(${hit.x.toFixed(2)}, ${hit.z.toFixed(2)}): ${segs[list[a]].who} × ${segs[list[b]].who}`);
        }
      }
    }
  }
  return { count, where };
}
