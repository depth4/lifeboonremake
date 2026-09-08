/**
 * Осмотр готового мира: цифры, по которым видно, сломан он или нет.
 *
 * Целость считается по МЕСТАМ рёбер, а не по номерам вершин. Две вершины
 * в одной точке — это излом (бордюр, край выемки), а не щель; сшито или нет,
 * видно по тому, сколько треугольников опирается на каждое ребро.
 * Без браузера. Используется и одиночной проверкой, и обстрелом случайными
 * постройками (`npm run fuzz`).
 */

import type { Surface } from '../src/surface/index.ts';
import { SEALED } from '../src/surface/index.ts';
import type { World } from '../src/world/world.ts';
import { MAX_GRADE } from '../src/world/world.ts';
import { WORLD_HALF } from '../src/world/terrain.ts';

export interface Report {
  readonly vertices: number;
  readonly triangles: number;
  /** незашитые рёбра внутри мира — через них видно небо */
  readonly holes: number;
  /** треугольники, повёрнутые изнанкой вверх: сквозь них тоже видно небо */
  readonly downFacing: number;
  /**
   * Самый вытянутый треугольник ЗАМКНУТОЙ поверхности: иглы дают рваное
   * освещение. Краску сюда не считаем — она лежит плашмя на асфальте и
   * светится вместе с ним, какой бы формы ни была.
   */
  readonly worstAspect: number;
  /** треугольники нулевой площади: не треугольники вовсе */
  readonly flat: number;
  /**
   * Самый крутой треугольник ПОЛОТНА — асфальта и тротуара, доля.
   * Вдоль дороги уклон ограничен, а поперёк никто его не ограничивал: на
   * перекрёстке высоты двух дорог сходились обрывом, и картинка это скрывала.
   * Здесь это видно числом.
   */
  readonly paved: number;
  /** самый крутой участок дороги, доля */
  readonly grade: number;
  /** самый большой отрыв дороги от земли, метры */
  readonly lift: number;
}

const onBorder = (x: number, z: number): boolean =>
  Math.abs(Math.abs(x) - WORLD_HALF) < 0.01 || Math.abs(Math.abs(z) - WORLD_HALF) < 0.01;

export function inspect(world: World, surface: Surface): Report {
  const P = surface.positions;
  const I = surface.indices;

  // Краска поверх асфальта в замкнутую поверхность не входит: её рёбра
  // и не должны ни на что опираться.
  const painted = new Uint8Array(I.length / 3);
  const paving = new Uint8Array(I.length / 3);
  for (const g of surface.groups) {
    if (!SEALED.includes(g.material)) {
      for (let i = g.start; i < g.start + g.count; i += 3) painted[i / 3] = 1;
    }
    if (g.material === 'asphalt' || g.material === 'sidewalk') {
      for (let i = g.start; i < g.start + g.count; i += 3) paving[i / 3] = 1;
    }
  }

  const key = (v: number): string =>
    `${Math.round(P[v * 3] * 1000)},${Math.round(P[v * 3 + 1] * 1000)},${Math.round(P[v * 3 + 2] * 1000)}`;

  const edges = new Map<string, number>();
  let downFacing = 0;
  let worstAspect = 0;
  let flat = 0;
  let paved = 0;

  for (let t = 0; t < I.length; t += 3) {
    const paint = painted[t / 3] === 1;
    if (!paint) {
      const k = [key(I[t]), key(I[t + 1]), key(I[t + 2])];
      for (let e = 0; e < 3; e++) {
        const pair = [k[e], k[(e + 1) % 3]].sort().join('|');
        edges.set(pair, (edges.get(pair) ?? 0) + 1);
      }
    }

    const p = [I[t], I[t + 1], I[t + 2]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    // площадь = len/2; квадратный микрометр — это уже не треугольник
    if (len < 2e-6) {
      flat++;
      continue;
    }
    // изнанкой вверх — только у земли: у бордюра вертикальные грани это норма
    if (n[1] / len < -0.2) downFacing++;
    // Ступенькой считаем только то, обо что можно споткнуться. Треугольник,
    // у которого все три вершины по высоте в пределах пяти сантиметров,
    // ступенькой быть не может, какой бы крутой ни выходила его плоскость:
    // у торца дороги такие крошки дают 20% на пустом месте.
    if (paving[t / 3] === 1) {
      const rise = Math.max(p[0][1], p[1][1], p[2][1]) - Math.min(p[0][1], p[1][1], p[2][1]);
      if (rise > 0.05) paved = Math.max(paved, Math.hypot(n[0], n[2]) / Math.max(1e-9, Math.abs(n[1])));
    }

    const sides = [
      Math.hypot(u[0], u[1], u[2]),
      Math.hypot(v[0], v[1], v[2]),
      Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2]),
    ];
    const longest = Math.max(...sides);
    const height = len / longest; // len/2 — площадь, высота = 2*площадь/основание
    if (!paint && height > 1e-9) worstAspect = Math.max(worstAspect, longest / height);
  }

  let holes = 0;
  for (const [pair, count] of edges) {
    if (count === 2) continue;
    const ends = pair.split('|').map((s) => s.split(',').map((n) => Number(n) / 1000));
    if (count === 1 && onBorder(ends[0][0], ends[0][2]) && onBorder(ends[1][0], ends[1][2])) continue;
    holes++;
  }

  return {
    vertices: surface.stats.vertices,
    triangles: surface.stats.triangles,
    holes,
    downFacing,
    worstAspect,
    flat,
    paved,
    grade: world.grade,
    lift: world.lift,
  };
}

/** Что из осмотра считается поломкой. Пустой список — всё в порядке. */
export function problems(r: Report): string[] {
  const out: string[] = [];
  if (r.holes > 0) out.push(`${r.holes} незашитых рёбер — сквозь них видно небо`);
  if (r.downFacing > 0) out.push(`${r.downFacing} треугольников земли повёрнуты изнанкой вверх`);
  if (r.flat > 0) out.push(`${r.flat} треугольников нулевой площади`);
  // вчетверо круче предельного продольного уклона — это уже не дорога,
  // а ступенька: машина в неё въедет
  if (r.paved > MAX_GRADE * 4) out.push(`полотно круче ${(r.paved * 100).toFixed(0)}% — это ступенька, а не дорога`);
  if (r.grade > MAX_GRADE + 0.001) out.push(`дорога круче предела: ${(r.grade * 100).toFixed(1)}%`);
  return out;
}
